import { Request, Response, NextFunction } from 'express';

export const validateApiKey = (req: Request, res: Response, next: NextFunction) => {
    const apiKey = req.headers['x-api-key'];
    const serviceApiKey = process.env.SERVICE_API_KEY;

    console.log(apiKey);
    console.log(serviceApiKey);

    if (!serviceApiKey) {
        console.error('SERVICE_API_KEY is not defined in environment variables.');
        return res.status(500).json({ error: 'Internal Server Error' });
    }

    if (!apiKey || apiKey !== serviceApiKey) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }

    next();
};
