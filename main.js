const express = require("express");
const axios = require("axios");
require("dotenv").config();
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const { CONSUMER_KEY, CONSUMER_SECRET, SHORTCODE, PASSKEY } = process.env;

// Store transaction statuses
const transactionStatus = new Map();

// Serve the HTML file
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Function to get OAuth token
const getOAuthToken = async () => {
  const url =
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString(
    "base64"
  );

  try {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Basic ${auth}` },
    });
    return data.access_token;
  } catch (error) {
    console.error("Error getting OAuth token:", error.message);
    throw error;
  }
};

app.post("/api/mpesa/transaction", async (req, res) => {
  const { phoneNumber, partyA, amount, CallbackURL } = req.body;

  try {
    const token = await getOAuthToken();
    const url =
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";
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

    res.json(responseData);
  } catch (error) {
    console.error("Error making transaction:", error.message);
    res.status(500).json({ error: error.message });
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
