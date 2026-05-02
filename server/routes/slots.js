const express = require('express');
const router = express.Router();

router.all('*', (req, res) => {
  res.status(501).json({ error: 'Not implemented', module: 'slots', path: req.path });
});

module.exports = router;
