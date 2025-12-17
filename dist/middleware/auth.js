"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateApiKey = void 0;
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const serviceApiKey = process.env.SERVICE_API_KEY;
    if (!serviceApiKey) {
        console.error('SERVICE_API_KEY is not defined in environment variables.');
        return res.status(500).json({ error: 'Internal Server Error' });
    }
    if (!apiKey || apiKey !== serviceApiKey) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }
    next();
};
exports.validateApiKey = validateApiKey;
