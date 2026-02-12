// app/server.js
const express = require('express');
const app = express();
const PORT = 3000;

app.get('/', (req, res) => {
    res.json({
        message: 'Hello from Node.js inside Kubernetes!',
        host: process.env.HOSTNAME, // Hogy lássuk, melyik Pod válaszol
        status: 'OK'
    });
});

app.listen(PORT, () => console.log(`Backend running on ${PORT}`));