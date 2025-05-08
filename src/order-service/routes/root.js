'use strict'

const http = require('http');

module.exports = async function (fastify, opts) {
  fastify.post('/', async function (request, reply) {
    const msg = request.body

    async function fetchIGConnection() {
      return new Promise((resolve, reject) => {
        const url = 'http://myexternalserver.com';

        const req = http.request(
          url,
          { headers: { 'User-Agent': 'order-service' } },
          res => {
            // if we didn’t get a 2xx, treat it as an error
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(new Error(`HTTP ${res.statusCode}`));
            }
            // success — we got a “real” 2xx response
            res.destroy();
            resolve('Connected to external server');
          }
        );

        req.on('error', err => reject(err));
        req.end();
      });
    }

    const order = JSON.stringify(msg);
    console.log(`Received order: ${order}`);

    // Only fetch IG version if "Inspektor Gadget" is in the order
    const includesIG = JSON.parse(order).items?.some(item => item.productId === 11);
    if (includesIG) {
      try {
        console.log('Connecting to Internet...');
        const result = await fetchIGConnection();
        await fastify.sendMessage(Buffer.from(JSON.stringify(msg)));
        reply.code(201).send({ status: 'message sent' });
      } catch (err) {
        console.error('Failed to connect to Internet:', err);
        reply.code(500).send({ error: 'Failed to send message' });
      }
    }
  })

  fastify.get('/health', async function (request, reply) {
    const appVersion = process.env.APP_VERSION || '0.1.0'
    return { status: 'ok', version: appVersion }
  })

  fastify.get('/hugs', async function (request, reply) {
    return { hugs: fastify.someSupport() }
  })
}
