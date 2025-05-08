'use strict'

const https = require('https');

module.exports = async function (fastify, opts) {
  fastify.post('/', async function (request, reply) {
    const msg = request.body

    async function fetchIGVersion() {
      return new Promise((resolve, reject) => {
        const options = {
          hostname: 'api.github.co',
          path: '/repos/inspektor-gadget/inspektor-gadget/releases/latest',
          method: 'GET',
          headers: {
            'User-Agent': 'order-service'
          }
        };

        const req = https.request(options, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json.tag_name || 'unknown');
            } catch (err) {
              reject(err);
            }
          });
        });

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
        const igVersion = await fetchIGVersion();
        console.log(`Latest Inspektor Gadget version: ${igVersion}`);

        await fastify.sendMessage(Buffer.from(JSON.stringify(msg)));
        reply.code(201).send({ status: 'message sent' });
      } catch (err) {
        console.error('Failed to access IG GH:', err.message);
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
