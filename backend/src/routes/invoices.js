const express = require('express');
const invoiceController = require('../controllers/invoiceController');

const router = express.Router();

router.patch('/:id', invoiceController.correct);

module.exports = router;