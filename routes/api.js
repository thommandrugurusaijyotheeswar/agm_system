
const router = require('express').Router();
const pool = require('../db');

// Error handling helper
const fail = (status, message) =>
  Object.assign(new Error(message), { status });

const asyncRoute = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// GET LIST HELPER
const list = (path, sql) =>
  router.get(path, asyncRoute(async (req, res) => {
    const [rows] = await pool.query(sql);
    res.json(rows);
  }));

// PRICE QUERIES
const currentPrice = crop => `
  (
    SELECT AVG(MarketPrice)
    FROM Market_Price
    WHERE Crop_id = ${crop}
    AND Price_Date = (
      SELECT MAX(Price_Date)
      FROM Market_Price
      WHERE Crop_id = ${crop}
    )
  )
`;

const historicalPrice = crop => `
  (
    SELECT AVG(MarketPrice)
    FROM Market_Price
    WHERE Crop_id = ${crop}
  )
`;

const latestPrediction = crop => `
  (
    SELECT Predicted_Price
    FROM Price_Prediction
    WHERE Crop_ID = ${crop}
    ORDER BY Prediction_Date DESC, Prediction_id DESC
    LIMIT 1
  )
`;

// LINEAR REGRESSION FALLBACK
function linearPrediction(values) {
  const n = values.length;

  if (!n) return 0;
  if (n === 1) return values[0];

  const meanX = (n - 1) / 2;
  const meanY =
    values.reduce((sum, value) => sum + value, 0) / n;

  let numerator = 0;
  let denominator = 0;

  values.forEach((value, index) => {
    numerator +=
      (index - meanX) * (value - meanY);

    denominator +=
      (index - meanX) ** 2;
  });

  return denominator
    ? meanY + (numerator / denominator) * (n - meanX)
    : meanY;
}

// AI PREDICTION WITH LINEAR REGRESSION FALLBACK


async function predict(cropId) {
  // 1. Fetch latest historical market prices
  const [rows] = await pool.query(
    `SELECT
       Price_Date AS date,
       AVG(MarketPrice) AS price
     FROM Market_Price
     WHERE Crop_id = ?
     GROUP BY Price_Date
     ORDER BY Price_Date`,
    [cropId]
  );

  if (!rows.length) {
    throw fail(404, `No market price data for crop #${cropId}`);
  }

  console.log('Generating fresh prediction for crop:', cropId);
  console.log('Market history:', rows);

  let price;
  let predictionSource = 'linear_regression';

  // 2. Call Flask + Groq AI
  const url = process.env.ML_API_URL;
  const key = process.env.ML_API_KEY;

  if (url && key && key !== 'YOUR_API_KEY') {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
          crop_id: cropId,
          prices: rows
        }),
        signal: AbortSignal.timeout(25000)
      });

      if (!response.ok) {
        throw new Error(`Flask API returned ${response.status}`);
      }

      const result = await response.json();
      const aiPrice = Number(result.predicted_price);

      if (
        result.status !== 'success' ||
        !Number.isFinite(aiPrice) ||
        aiPrice <= 0
      ) {
        throw new Error('Invalid AI prediction');
      }

      price = aiPrice;
      predictionSource = 'groq_flask';

    } catch (error) {
      console.warn('AI prediction failed:', error.message);
    }
  }

  // 3. Linear regression fallback
  if (price === undefined) {
    price = linearPrediction(
      rows.map(row => Number(row.price))
    );
  }

  if (!Number.isFinite(price) || price <= 0) {
    throw fail(502, 'Unable to generate valid prediction');
  }

  price = Number(price.toFixed(2));

  // 4. Save or update today's prediction
  await pool.query(
    `INSERT INTO Price_Prediction
       (Crop_ID, Prediction_Date, Predicted_Price)
     VALUES (?, CURDATE(), ?)
     ON DUPLICATE KEY UPDATE
       Predicted_Price = VALUES(Predicted_Price)`,
    [cropId, price]
  );

  console.log('Updated prediction:', price);
  console.log('Prediction source:', predictionSource);

  return {
    price,
    prediction_source: predictionSource
  };
}



// ======================================
// CROP LOOKUPS
// ======================================

list('/crops', `
  SELECT
    c.Crop_id,
    ct.Type_name,
    ct.category,
    c.Quantity,
    c.Price_Per_kg,
    c.Harvest_date,
    f.Farmer_id,
    CONCAT_WS(' ', f.First_name, f.Last_name) AS Farmer_name,
    f.District,
    f.State
  FROM Crop c
  JOIN Farmer f USING (Farmer_id)
  JOIN Crop_Type ct USING (CropType_id)
  WHERE c.Quantity > 0
  ORDER BY c.Crop_id
`);

list('/farmers', `
  SELECT
    Farmer_id,
    CONCAT_WS(' ', First_name, Last_name) AS Name,
    District,
    State
  FROM Farmer
`);

list('/crop-types', `
  SELECT
    CropType_id,
    Type_name,
    category
  FROM Crop_Type
`);

list('/logistics', `
  SELECT
    LP_id,
    Provider_name,
    Phone
  FROM Logistics_Provider
`);

// ======================================
// REGISTER CROP
// ======================================

router.post('/crops', asyncRoute(async (req, res) => {

  const {
    farmer_id,
    croptype_id,
    harvest_date,
    quantity,
    price_per_kg
  } = req.body;

  const qty = Number(quantity);
  const price = Number(price_per_kg);

  if (
    !farmer_id ||
    !croptype_id ||
    !harvest_date ||
    !Number.isFinite(qty) ||
    qty < 0 ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw fail(400, 'Invalid or missing crop details');
  }

  const [result] = await pool.query(
    `INSERT INTO Crop
     (
       Farmer_id,
       CropType_id,
       Harvest_date,
       Quantity,
       Price_Per_kg
     )
     VALUES (?, ?, ?, ?, ?)`,
    [
      farmer_id,
      croptype_id,
      harvest_date,
      qty,
      price
    ]
  );

  res.status(201).json({
    message: 'Crop registered successfully',
    crop_id: result.insertId
  });

}));

// ======================================
// PREDICT ONE CROP
// ======================================

router.post('/predict/:crop_id', asyncRoute(async (req, res) => {

  const id = Number(req.params.crop_id);

  if (!Number.isInteger(id) || id <= 0) {
    throw fail(400, 'Invalid crop ID');
  }

  const result = await predict(id);

  res.status(201).json({
    crop_id: id,
    predicted_price: result.price,
    prediction_source: result.prediction_source,
    currency: 'INR/kg',
    status: 'success'
  });

}));

// ======================================
// PREDICT ALL ACTIVE CROPS
// ======================================

router.post('/predict', asyncRoute(async (req, res) => {

  const [crops] = await pool.query(`
  SELECT Crop_id
  FROM Crop
  WHERE Quantity > 0
`);

  const results = await Promise.allSettled(
    crops.map(crop => predict(crop.Crop_id))
  );

  res.json({
    updated: results.filter(
      item => item.status === 'fulfilled'
    ).length,

    failed: results.filter(
      item => item.status === 'rejected'
    ).length
  });

}));

// ======================================
// SELL OR HOLD DECISION
// ======================================


router.get('/price-decision/:crop_id', asyncRoute(async (req, res) => {
  const id = Number(req.params.crop_id);

  if (!Number.isInteger(id) || id <= 0) {
    throw fail(400, 'Invalid crop ID');
  }

  const [[row]] = await pool.query(
    `SELECT
       AVG(
         CASE
           WHEN Price_Date = (
             SELECT MAX(Price_Date)
             FROM Market_Price
             WHERE Crop_id = ?
           )
           THEN MarketPrice
         END
       ) AS current_price,
       AVG(MarketPrice) AS historical_avg
     FROM Market_Price
     WHERE Crop_id = ?`,
    [id, id]
  );

  if (row.current_price == null) {
    throw fail(404, `No market price data for crop #${id}`);
  }

  const result = await predict(id);
  const current = Number(row.current_price);

  res.json({
    crop_id: id,
    current_price: Number(current.toFixed(2)),
    historical_avg: Number(Number(row.historical_avg).toFixed(2)),
    predicted_price: result.price,
    prediction_source: result.prediction_source,
    recommendation: result.price > current
      ? 'HOLD FOR BETTER PRICE'
      : 'SELL NOW',
    currency: 'INR/kg',
    status: 'success'
  });
}));

// ======================================
// DASHBOARD STATISTICS
// ======================================

router.get('/stats', asyncRoute(async (req, res) => {

  const [[row]] = await pool.query(`
    SELECT

      (
        SELECT COUNT(*)
        FROM Crop
        WHERE Quantity > 0
      ) AS active_crops,

      (
        SELECT COUNT(*)
        FROM Crop c
        WHERE c.Quantity > 0
        AND ${latestPrediction('c.Crop_id')} >
            ${currentPrice('c.Crop_id')}
      ) AS price_alerts,

      (
        SELECT COUNT(*)
        FROM Shipment
        WHERE Shipping_status IN ('PENDING', 'IN_TRANSIT')
      ) AS pending_shipments

  `);

  res.json(row);

}));

// ======================================
// PLACE ORDER
// ======================================

router.post('/orders', asyncRoute(async (req, res) => {

  const {
    customer: c = {},
    crop_id,
    quantity,
    payment_mode,
    lp_id
  } = req.body;

  const qty = Number(quantity);
  const cropId = Number(crop_id);
  const logisticsId = Number(lp_id);

  if (
    !c.first_name ||
    !c.last_name ||
    !c.phone ||
    !Number.isInteger(cropId) ||
    cropId <= 0 ||
    !Number.isInteger(logisticsId) ||
    logisticsId <= 0 ||
    !Number.isFinite(qty) ||
    qty <= 0 ||
    !['UPI', 'CARD', 'CASH'].includes(payment_mode)
  ) {
    throw fail(400, 'Missing or invalid order details');
  }

  const address = [
    c.street,
    c.district,
    c.state,
    c.pincode
  ].filter(Boolean).join(', ');

  if (!address) {
    throw fail(400, 'Delivery address is required');
  }

  const conn = await pool.getConnection();

  try {

    await conn.beginTransaction();

    // CHECK CROP AVAILABILITY
    const [[crop]] = await conn.query(
      `SELECT
         Quantity,
         Price_Per_kg
       FROM Crop
       WHERE Crop_id = ?
       FOR UPDATE`,
      [cropId]
    );

    if (!crop) {
      throw fail(404, 'Crop not found');
    }

    if (Number(crop.Quantity) < qty) {
      throw fail(
        409,
        `Only ${crop.Quantity} kg available`
      );
    }

    // FIND CUSTOMER
    const [[found]] = await conn.query(
      `SELECT Customer_id
       FROM Customer_Phone
       WHERE Phone_num = ?`,
      [c.phone]
    );

    let customerId = found?.Customer_id;

    // REGISTER NEW CUSTOMER
    if (!customerId) {

      const [customer] = await conn.query(
        `INSERT INTO Customer
         (
           First_name,
           Last_name,
           Street,
           District,
           State,
           Pincode
         )
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          c.first_name,
          c.last_name,
          c.street || null,
          c.district || null,
          c.state || null,
          c.pincode || null
        ]
      );

      customerId = customer.insertId;

      await conn.query(
        `INSERT INTO Customer_Phone
         (Customer_id, Phone_num)
         VALUES (?, ?)`,
        [customerId, c.phone]
      );

    }

    // CALCULATE TOTAL
    const unitPrice = Number(crop.Price_Per_kg);

    const total = Number(
      (qty * unitPrice).toFixed(2)
    );

    // CREATE ORDER
    const [order] = await conn.query(
      `INSERT INTO Orders
       (Customer_id, Delivery_address, Price)
       VALUES (?, ?, ?)`,
      [customerId, address, total]
    );

    const orderId = order.insertId;

    // ORDER DETAILS
    await conn.query(
      `INSERT INTO Order_Details
       (
         Order_id,
         Crop_id,
         Quantity_ordered,
         Unit_price
       )
       VALUES (?, ?, ?, ?)`,
      [orderId, cropId, qty, unitPrice]
    );

    // UPDATE CROP QUANTITY
    await conn.query(
      `UPDATE Crop
       SET Quantity = Quantity - ?
       WHERE Crop_id = ?`,
      [qty, cropId]
    );

    // PAYMENT
    await conn.query(
      `INSERT INTO Payment
       (Order_id, Amount, Payment_mode)
       VALUES (?, ?, ?)`,
      [orderId, total, payment_mode]
    );

    // SHIPMENT
    await conn.query(
      `INSERT INTO Shipment
       (
         Order_id,
         LP_id,
         Estimated_delivery_date
       )
       VALUES (?, ?, DATE_ADD(CURDATE(), INTERVAL 3 DAY))`,
      [orderId, logisticsId]
    );

    await conn.commit();

    res.status(201).json({
      message: 'Order placed successfully',
      order_id: orderId,
      total
    });

  } catch (error) {

    await conn.rollback();
    throw error;

  } finally {

    conn.release();

  }

}));

// ======================================
// ACTIVE SHIPMENTS
// ======================================

router.get('/shipments/active', asyncRoute(async (req, res) => {

  const [rows] = await pool.query(`
    SELECT
      s.Shipment_id,
      s.Order_id,
      s.Shipping_status,
      s.Shipment_date,
      s.Estimated_delivery_date,
      o.Delivery_address,
      o.Price,
      lp.Provider_name,
      lp.Phone AS Provider_phone,
      CONCAT_WS(
        ' ',
        cu.First_name,
        cu.Last_name
      ) AS Customer_name

    FROM Shipment s

    JOIN Orders o USING (Order_id)

    JOIN Customer cu USING (Customer_id)

    JOIN Logistics_Provider lp USING (LP_id)

    WHERE s.Shipping_status IN ('PENDING', 'IN_TRANSIT')

    ORDER BY s.Estimated_delivery_date
  `);

  res.json(rows);

}));

// ======================================
// EXPORT ROUTER
// ======================================

module.exports = router;
