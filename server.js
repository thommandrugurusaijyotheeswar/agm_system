require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());                       // built into Express, replaces body-parser
app.use(express.static('public'));
app.use('/api', require('./routes/api'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Agri Market running at http://localhost:${port}`));
