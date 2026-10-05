USE agri_market;

INSERT INTO Farmer (Farmer_id, First_name, Last_name, Street, District, State, Pincode) VALUES
  (1, 'Murugan', 'Selvam', '12 Paddy Lane', 'Chengalpattu', 'Tamil Nadu', '603001'),
  (2, 'Lakshmi', 'Devi',   '8 Mill Road',   'Thanjavur',    'Tamil Nadu', '613001');
INSERT INTO Farmer_Phone (Farmer_id, Phone_num) VALUES (1, '9876543210'), (2, '9876500000');

INSERT INTO Crop_Type (CropType_id, Type_name, category) VALUES
  (1, 'Ponni Rice', 'Cereal'), (2, 'Tomato', 'Vegetable'), (3, 'Groundnut', 'Oilseed');

INSERT INTO Crop (Crop_id, Farmer_id, CropType_id, Harvest_date, Quantity, Price_Per_kg) VALUES
  (1, 1, 1, CURDATE(), 1000, 32), (2, 1, 2, CURDATE(), 300, 18), (3, 2, 3, CURDATE(), 500, 70);

INSERT INTO Market_Price (Crop_id, Market_Name, Price_Date, MarketPrice) VALUES
  (1, 'Koyambedu', CURDATE() - INTERVAL 7 DAY, 30), (1, 'Koyambedu', CURDATE(), 33),
  (2, 'Koyambedu', CURDATE() - INTERVAL 7 DAY, 22), (2, 'Koyambedu', CURDATE(), 16),
  (3, 'Thanjavur Mandi', CURDATE(), 68);

INSERT INTO Price_Prediction (Crop_ID, Prediction_Date, Predicted_Price) VALUES
  (1, CURDATE() + INTERVAL 14 DAY, 36), (2, CURDATE() + INTERVAL 14 DAY, 14), (3, CURDATE() + INTERVAL 14 DAY, 75);

INSERT INTO Logistics_Provider (Provider_name, Phone) VALUES
  ('FastFarm Logistics', '9000011111'), ('GreenRoute Carriers', '9000022222');
