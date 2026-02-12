// app/server.js
const express = require('express');
const app = express();
const PORT = 3000;

app.get('/', (req, res) => {
    res.send(`
        <h1>🚀 Működik a Kubernetes Cluster!</h1>
        <p>Ezt az oldalt az Nginx szolgálja ki, a háttérben pedig a Node.js fut.</p>
        <hr>
        <p>Pod neve: ${process.env.HOSTNAME}</p>
    `);
});

app.listen(PORT, () => console.log(`Backend running on ${PORT}`));