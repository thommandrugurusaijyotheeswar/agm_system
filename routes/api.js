const router = require('express').Router();
const pool = require('../db');

// Wrap async handlers so errors become JSON responses; fail() attaches an HTTP status
const h = fn => (req, res) => fn(req, res).catch(e => res.status(e.status || 500).json({ error: e.message }));
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const list = (path, sql) => router.get(path, h(async (_req, res) => res.json((await pool.query(sql))[0])));

// ---- Price subqueries, reused by /price-decision and /stats (c = crop id expression) ----
const cur  = c => `(SELECT AVG(MarketPrice) FROM Market_Price WHERE Crop_id = ${c}
                    AND Price_Date = (SELECT MAX(Price_Date) FROM Market_Price WHERE Crop_id = ${c}))`;
const hist = c => `(SELECT AVG(MarketPrice) FROM Market_Price WHERE Crop_id = ${c})`;
const pred = c => `(SELECT Predicted_Price FROM Price_Prediction WHERE Crop_ID = ${c}
                    ORDER BY Prediction_Date DESC, Prediction_id DESC LIMIT 1)`;

// ---- Lookups ----
list('/crops', `SELECT c.Crop_id, ct.Type_name, ct.category, c.Quantity, c.Price_Per_kg, c.Harvest_date,
                       f.Farmer_id, CONCAT_WS(' ', f.First_name, f.Last_name) AS Farmer_name, f.District, f.State
                FROM Crop c JOIN Farmer f USING (Farmer_id) JOIN Crop_Type ct USING (CropType_id)
                WHERE c.Quantity > 0 ORDER BY c.Crop_id`);
list('/farmers', `SELECT Farmer_id, CONCAT_WS(' ', First_name, Last_name) AS Name, District, State FROM Farmer`);
list('/crop-types', 'SELECT CropType_id, Type_name, category FROM Crop_Type');
list('/logistics', 'SELECT LP_id, Provider_name, Phone FROM Logistics_Provider');

// ---- Register a crop listing ----
router.post('/crops', h(async (req, res) => {
  const { farmer_id, croptype_id, harvest_date, quantity, price_per_kg } = req.body;
  if (!farmer_id || !croptype_id || !harvest_date || !(quantity >= 0) || !(price_per_kg > 0))
    throw fail(400, 'farmer_id, croptype_id, harvest_date, quantity and price_per_kg are required');
  const [r] = await pool.query(
    'INSERT INTO Crop (Farmer_id, CropType_id, Harvest_date, Quantity, Price_Per_kg) VALUES (?,?,?,?,?)',
    [farmer_id, croptype_id, harvest_date, quantity, price_per_kg]);
  res.status(201).json({ crop_id: r.insertId });
}));

// ---- Sell/hold advice for one crop ----
router.get('/price-decision/:crop_id', h(async (req, res) => {
  const id = Number(req.params.crop_id);
  if (!Number.isInteger(id)) throw fail(400, 'crop_id must be an integer');
  const [[row]] = await pool.query(
    `SELECT ${cur('?')} AS current_price, ${hist('?')} AS historical_avg, ${pred('?')} AS predicted_price`,
    [id, id, id, id]);
  if (row.current_price == null) throw fail(404, 'No market price data for this crop');
  res.json({
    crop_id: id,
    current_price: +row.current_price.toFixed(2),
    historical_avg: +row.historical_avg.toFixed(2),
    predicted_price: row.predicted_price,
    recommendation: row.predicted_price > row.current_price ? 'HOLD FOR BETTER PRICE' : 'SELL NOW'
  });
}));

// ---- Dashboard stat cards ----
router.get('/stats', h(async (_req, res) => {
  const [[row]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM Crop WHERE Quantity > 0) AS active_crops,
            (SELECT COUNT(*) FROM Crop c WHERE c.Quantity > 0 AND ${pred('c.Crop_id')} > ${cur('c.Crop_id')}) AS price_alerts,
            (SELECT COUNT(*) FROM Shipment WHERE Shipping_status IN ('PENDING','IN_TRANSIT')) AS pending_shipments`);
  res.json(row);
}));

// ---- Place an order: one atomic transaction ----
router.post('/orders', h(async (req, res) => {
  const { customer: c = {}, crop_id, quantity, payment_mode, lp_id } = req.body;
  const qty = Number(quantity);
  if (!c.first_name || !c.last_name || !c.phone || !crop_id || !lp_id || !(qty > 0) ||
      !['UPI', 'CARD', 'CASH'].includes(payment_mode))
    throw fail(400, 'Missing or invalid order fields');
  const address = [c.street, c.district, c.state, c.pincode].filter(Boolean).join(', ');
  if (!address) throw fail(400, 'Delivery address is required');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock the crop row so concurrent buyers cannot oversell
    const [[crop]] = await conn.query('SELECT Quantity, Price_Per_kg FROM Crop WHERE Crop_id = ? FOR UPDATE', [crop_id]);
    if (!crop) throw fail(404, 'Crop not found');
    if (crop.Quantity < qty) throw fail(409, `Only ${crop.Quantity} kg available`);

    // Reuse the customer with this phone number, otherwise create one
    const [[found]] = await conn.query('SELECT Customer_id FROM Customer_Phone WHERE Phone_num = ?', [c.phone]);
    let customerId = found?.Customer_id;
    if (!customerId) {
      const [r] = await conn.query(
        'INSERT INTO Customer (First_name, Last_name, Street, District, State, Pincode) VALUES (?,?,?,?,?,?)',
        [c.first_name, c.last_name, c.street || null, c.district || null, c.state || null, c.pincode || null]);
      customerId = r.insertId;
      await conn.query('INSERT INTO Customer_Phone (Customer_id, Phone_num) VALUES (?,?)', [customerId, c.phone]);
    }

    const total = +(qty * crop.Price_Per_kg).toFixed(2);
    const [o] = await conn.query('INSERT INTO Orders (Customer_id, Delivery_address, Price) VALUES (?,?,?)',
      [customerId, address, total]);
    const orderId = o.insertId;

    await conn.query('INSERT INTO Order_Details (Order_id, Crop_id, Quantity_ordered, Unit_price) VALUES (?,?,?,?)',
      [orderId, crop_id, qty, crop.Price_Per_kg]);
    await conn.query('UPDATE Crop SET Quantity = Quantity - ? WHERE Crop_id = ?', [qty, crop_id]);
    await conn.query('INSERT INTO Payment (Order_id, Amount, Payment_mode) VALUES (?,?,?)', [orderId, total, payment_mode]);
    await conn.query(
      'INSERT INTO Shipment (Order_id, LP_id, Estimated_delivery_date) VALUES (?,?,DATE_ADD(CURDATE(), INTERVAL 3 DAY))',
      [orderId, lp_id]);

    await conn.commit();
    res.status(201).json({ order_id: orderId, total });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}));

// ---- Pending / in-transit shipments with provider contact ----
router.get('/shipments/active', h(async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT s.Shipment_id, s.Order_id, s.Shipping_status, s.Shipment_date, s.Estimated_delivery_date,
            o.Delivery_address, o.Price, lp.Provider_name, lp.Phone AS Provider_phone,
            CONCAT_WS(' ', cu.First_name, cu.Last_name) AS Customer_name
     FROM Shipment s
     JOIN Orders o USING (Order_id)
     JOIN Customer cu USING (Customer_id)
     JOIN Logistics_Provider lp USING (LP_id)
     WHERE s.Shipping_status IN ('PENDING','IN_TRANSIT')
     ORDER BY s.Estimated_delivery_date`);
  res.json(rows);
}));

module.exports = router;
