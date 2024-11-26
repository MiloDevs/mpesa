const express = require("express");
const axios = require("axios");
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const NodeCache = require("node-cache");
const { createClient } = require('redis');

const app = express();
app.use(express.json());
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
app.use(express.static(path.join(__dirname, "public")));
app.use(cors());

const { CONSUMER_KEY, CONSUMER_SECRET, SHORTCODE, PASSKEY, NODE_ENV } =
  process.env;

const BASE_URL =
  NODE_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

const cache = new NodeCache({ stdTTL: 3500 });

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});

app.use("/api/", apiLimiter);

app.get("/instructions", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "instructions.html"));
});

const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://redis:6379'
});

redisClient.on('error', err => console.error('Redis Client Error', err));
redisClient.on('connect', () => console.log('Connected to Redis'));

// Connect to Redis when the app starts
(async () => {
  await redisClient.connect();
})();

const saveTransactionStatus = async (checkoutRequestId, status) => {
  try {
    await redisClient.hSet('transaction_statuses', checkoutRequestId, JSON.stringify(status));
  } catch (error) {
    console.error('Error saving to Redis:', error);
  }
};

const getTransactionStatus = async (checkoutRequestId) => {
  try {
    const status = await redisClient.hGet('transaction_statuses', checkoutRequestId);
    return status ? JSON.parse(status) : null;
  } catch (error) {
    console.error('Error getting from Redis:', error);
    return null;
  }
};

const getAllTransactionStatuses = async () => {
  try {
    const statuses = await redisClient.hGetAll('transaction_statuses');
    return Object.entries(statuses).reduce((acc, [key, value]) => {
      acc[key] = JSON.parse(value);
      return acc;
    }, {});
  } catch (error) {
    console.error('Error getting all statuses from Redis:', error);
    return {};
  }
};

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const getOAuthToken = async () => {
  const cachedToken = cache.get("oauth_token");
  if (cachedToken) return cachedToken;

  const url = `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`;
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString(
    "base64"
  );

  try {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Basic ${auth}` },
    });
    cache.set("oauth_token", data.access_token);
    return data.access_token;
  } catch (error) {
    console.error(
      "Error getting OAuth token:",
      error.response?.data || error.message
    );
    throw error;
  }
};

const getOAuthTokenWithRetry = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await getOAuthToken();
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error.message);
      if (i === retries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
};

app.post("/api/mpesa/transaction", async (req, res) => {
  const { phoneNumber, partyA, amount, CallbackURL } = req.body;

  if (!phoneNumber || !partyA || !amount || !CallbackURL) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // sanitize the phone number if it starts with 0, replace it with +254 else leave it as is
  const sanitizedPhoneNumber = phoneNumber.replace(/\s+/g, '').replace(/^0/, '+254');

  try {
    const token = await getOAuthTokenWithRetry();
    const url = `${BASE_URL}/mpesa/stkpush/v1/processrequest`;
    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, -3);
    const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString(
      "base64"
    );

    const data = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: partyA,
      PartyB: SHORTCODE,
      PhoneNumber: sanitizedPhoneNumber,
      CallBackURL: CallbackURL,
      AccountReference: "test123",
      TransactionDesc: "Payment for XYZ",
    };

    const { data: responseData } = await axios.post(url, data, {
      headers: { Authorization: `Bearer ${token}` },
    });

    await saveTransactionStatus(responseData.CheckoutRequestID, {
      status: "Pending",
      message: "Waiting for user input",
    });

    res.json(responseData);
  } catch (error) {
    console.error(
      "Error making transaction:",
      error.response?.data || error.message
    );
    res
      .status(500)
      .json({
        error: "Failed to initiate transaction. Please try again later.",
      });
  }
});

app.post("/callback", async (req, res) => {
  console.log("Callback received:", req.body);
  const {
    Body: { stkCallback },
  } = req.body;

  if (stkCallback) {
    const { CheckoutRequestID, ResultCode, ResultDesc } = stkCallback;
    await saveTransactionStatus(CheckoutRequestID, {
      status: ResultCode === 0 ? "Completed" : "Failed",
      message: ResultCode === 0 ? "Transaction successful" : ResultDesc,
    });
  }

  res.sendStatus(200);
});

app.get("/api/mpesa/status/:transactionId", async (req, res) => {
  const { transactionId } = req.params;
  const status = await getTransactionStatus(transactionId) || {
    status: "Unknown",
    message: "No status available",
  };
  res.json(status);
});

app.get("/api/mpesa/statuses", async (req, res) => {
  const statuses = await getAllTransactionStatuses();
  res.json(statuses);
});

app.get("/api/health", async (req, res) => {
  try {
    await getOAuthToken();
    res.status(200).json({ status: "OK" });
  } catch (error) {
    res.status(500).json({ status: "Error", message: error.message });
  }
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  await redisClient.quit();
  process.exit(0);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
