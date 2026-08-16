// Pins the env the config module requires, so importing application code in a
// test never depends on the developer's shell or a local .env.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.PORT ??= '0';
process.env.MONGO_URI ??= 'mongodb://127.0.0.1:27017/askpdf-test';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379/1';
process.env.GEMINI_API_KEY ??= 'AIzaSyD-notarealkey-0000000000000000000';
process.env.JWT_ACCESS_SECRET ??= 'Mp3lKjG98J3l6LGGFoPs7DACKSgFsR5MIerz+pZxcvxvozcx';
process.env.JWT_REFRESH_SECRET ??= 'EM2cvYgTBH7ZR3WacNK9EK7p+vKDmLpTpylB4ykk0vJ4jSpz';

// Suites drive many requests through one app instance; the limiter itself has
// a dedicated test that sets its own bounds.
process.env.RATE_LIMIT_MAX ??= '100000';
process.env.RATE_LIMIT_AUTH_MAX ??= '100000';
process.env.RATE_LIMIT_UPLOAD_MAX ??= '100000';
process.env.RATE_LIMIT_CHAT_MAX ??= '100000';
