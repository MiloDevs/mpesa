const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();

const consumerKey = process.env.CONSUMER_KEY;
const consumerSecret = process.env.CONSUMER_SECRET;
const shortcode = process.env.SHORTCODE;
const passkey = process.env.PASSKEY;

// Function to get OAuth token
const getOAuthToken = async () => {
  const url =
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString(
    "base64"
  );

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });
    return response.data.access_token;
  } catch (error) {
    console.error("Error getting OAuth token:", error);
    throw error;
  }
};

app.get("/api", (req, res) => {
  res.json({
    message: "Welcome to the API",
  });
});

app.get("/api/credentials", (req, res) => {
  res.json({
    consumerKey,
    consumerSecret,
  });
});

app.post("/api/mpesa/transaction", async (req, res) => {
  const token = await getOAuthToken();
  const phoneNumber = req.body.phoneNumber;
  const partyA = req.body.partyA;
  const amount = req.body.amount;
  const callbackURL = req.body.CallbackURL;
  const url = "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

  const date = new Date();
  const timestamp = date
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, -3);
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString(
    "base64"
  );

  const data = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: amount,
    PartyA: partyA,
    PartyB: shortcode,
    PhoneNumber: phoneNumber,
    CallBackURL: callbackURL,
    AccountReference: "test123",
    TransactionDesc: "Payment for XYZ",
  };

  try {
    const response = await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    res.json(response.data);
  } catch (error) {
    console.error("Error making transaction:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to receive callback from MPesa
app.post("/callback", (req, res) => {
  console.log("Callback received:", req.body);
  // Process the callback data here
  res.sendStatus(200);
});

app.listen(5000, () => {
  console.log("Server listening on port 5000");
});
