module.exports = {
    apps: [
        {
            name: 'whatsapp-gateway',
            script: 'index.js',
            exec_mode: 'fork',   // or 'cluster'
            instances: 1,        // or 'max' for cluster
        },
    ],
};
