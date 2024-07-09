const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const consumerKey = process.env.CONSUMER_KEY;
const consumerSecret = process.env.CONSUMER_SECRET;
const shortcode = process.env.SHORTCODE;
const passkey = process.env.PASSKEY;

// Store transaction statuses
const transactionStatus = {};

// alive
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

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

// Validate phone number
const isValidPhoneNumber = (phoneNumber) => {
  const phoneRegex = /^[0-9]{12}$/; // Assuming phone number should be 12 digits long
  return phoneRegex.test(phoneNumber);
};

app.post("/api/mpesa/transaction", async (req, res) => {
  console.log("Request body:", req.body);

  const { phoneNumber, partyA, amount, CallbackURL } = req.body;


  try {
    const token = await getOAuthToken();
    const url =
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

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
      CallBackURL: CallbackURL,
      AccountReference: "test123",
      TransactionDesc: "Payment for XYZ",
    };

    const response = await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    // Store initial status
    transactionStatus[response.data.CheckoutRequestID] = {
      status: "Pending",
      message: "Waiting for user input",
    };

    res.json(response.data);
  } catch (error) {
    console.error("Error making transaction:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to receive callback from MPesa
app.post("/callback", (req, res) => {
  console.log("Callback received:", req.body);
  const {
    Body: { stkCallback },
  } = req.body;

  if (stkCallback) {
    const { CheckoutRequestID, ResultCode, ResultDesc } = stkCallback;
    if (ResultCode === 0) {
      transactionStatus[CheckoutRequestID] = {
        status: "Completed",
        message: "Transaction successful",
      };
    } else {
      transactionStatus[CheckoutRequestID] = {
        status: "Failed",
        message: ResultDesc,
      };
    }
  }

  res.sendStatus(200);
});

// Endpoint to get transaction status
app.get("/api/mpesa/status/:transactionId", (req, res) => {
  const { transactionId } = req.params;
  const status = transactionStatus[transactionId] || {
    status: "Unknown",
    message: "No status available",
  };
  res.json(status);
});

app.listen(5000, () => {
  console.log("Server listening on port 5000");
});
