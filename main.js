const express = require("express");
const axios = require("axios");
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const NodeCache = require("node-cache");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(cors());

const { CONSUMER_KEY, CONSUMER_SECRET, SHORTCODE, PASSKEY, NODE_ENV } =
  process.env;

const BASE_URL =
  NODE_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

const cache = new NodeCache({ stdTTL: 3500 });
const transactionStatus = new Map();

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});

app.use("/api/", apiLimiter);

const writeStatusToFile = () => {
  const statuses = Object.fromEntries(transactionStatus);
  const filePath = path.join(__dirname, "transaction_statuses.json");
  fs.writeFileSync(filePath, JSON.stringify(statuses, null, 2));
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
      PhoneNumber: phoneNumber,
      CallBackURL: CallbackURL,
      AccountReference: "test123",
      TransactionDesc: "Payment for XYZ",
    };

    const { data: responseData } = await axios.post(url, data, {
      headers: { Authorization: `Bearer ${token}` },
    });

    transactionStatus.set(responseData.CheckoutRequestID, {
      status: "Pending",
      message: "Waiting for user input",
    });

    writeStatusToFile();

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

app.post("/callback", (req, res) => {
  console.log("Callback received:", req.body);
  const {
    Body: { stkCallback },
  } = req.body;

  if (stkCallback) {
    const { CheckoutRequestID, ResultCode, ResultDesc } = stkCallback;
    transactionStatus.set(CheckoutRequestID, {
      status: ResultCode === 0 ? "Completed" : "Failed",
      message: ResultCode === 0 ? "Transaction successful" : ResultDesc,
    });

    writeStatusToFile();
  }

  res.sendStatus(200);
});

app.get("/api/mpesa/status/:transactionId", (req, res) => {
  const { transactionId } = req.params;
  const status = transactionStatus.get(transactionId) || {
    status: "Unknown",
    message: "No status available",
  };
  res.json(status);
});

app.get("/api/mpesa/statuses", (req, res) => {
  const statuses = Object.fromEntries(transactionStatus);
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
