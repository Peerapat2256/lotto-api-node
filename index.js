const express = require("express");
const mysql = require("mysql2");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const bodyParser = require("body-parser");
const { register } = require("module");
const { resolve } = require("path");
const { rejects } = require("assert");
const { error, log } = require("console");
const { emit } = require("process");

const app = express();
port = 3000;

var os = require("os");
var ip = "0.0.0.0";
var ips = os.networkInterfaces();
Object.keys(ips).forEach(function (_interface) {
  ips[_interface].forEach(function (_dev) {
    if (_dev.family === "IPv4" && !_dev.internal) ip = _dev.address;
  });
});

// =============== DATABASE CONNECTION POOL - OPTIMIZED ===============
// =============== DATABASE CONNECTION POOL - FIREBASE ADAPTER ===============
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Filter } = require('firebase-admin/firestore');
const path = require('path');
const fs = require('fs');

let serviceAccount;
const localKeyPath = path.join(__dirname, 'firebase-admin.json');
if (fs.existsSync(localKeyPath)) {
  serviceAccount = require('./firebase-admin.json');
} else if (process.env.FIREBASE_CREDENTIALS) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
  } catch (e) {
    console.error("❌ Failed to parse FIREBASE_CREDENTIALS env variable as JSON", e);
  }
}

if (!serviceAccount) {
  console.error("❌ Firebase service account credentials not found! Place firebase-admin.json locally or set FIREBASE_CREDENTIALS environment variable.");
  process.exit(1);
}

initializeApp({
  credential: cert(serviceAccount)
});

const firestore = getFirestore();

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || "abcdefg";
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || "aabbccddeeffgg";

// Helper function to auto-increment IDs in Firestore
async function getNextId(collectionName) {
  const counterRef = firestore.collection('counters').doc(collectionName);
  let nextId = 1;
  await firestore.runTransaction(async (transaction) => {
    const doc = await transaction.get(counterRef);
    if (!doc.exists) {
      transaction.set(counterRef, { count: 1 });
      nextId = 1;
    } else {
      nextId = doc.data().count + 1;
      transaction.update(counterRef, { count: nextId });
    }
  });
  return nextId;
}

// Helper to delete all documents in a collection (mock delete)
async function deleteCollection(collectionName) {
  const snapshot = await firestore.collection(collectionName).get();
  const batch = firestore.batch();
  snapshot.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
  await firestore.collection('counters').doc(collectionName).set({ count: 0 });
}

const db = {
  query: function (sql, params, callback) {
    let query = sql.trim();
    let args = params || [];

    if (typeof params === 'function') {
      callback = params;
      args = [];
    }

    (async () => {
      try {
        const uppercaseSql = query.toUpperCase();

        // 1. Transaction helpers (mocked success)
        if (uppercaseSql === 'START TRANSACTION' || uppercaseSql === 'BEGIN TRANSACTION' || uppercaseSql === 'COMMIT' || uppercaseSql === 'ROLLBACK') {
          return callback(null, { affectedRows: 0 });
        }

        // 2. Clear table / Delete endpoints
        if (uppercaseSql.startsWith('DELETE FROM')) {
          if (uppercaseSql.includes('WINNING_NUMBERS')) {
            await deleteCollection('winning_numbers');
          } else if (uppercaseSql.includes('PURCHASES')) {
            await deleteCollection('purchases');
          } else if (uppercaseSql.includes('LOTTO_NUMBERS')) {
            await deleteCollection('lotto_numbers');
          } else if (uppercaseSql.includes('USERS')) {
            // "DELETE FROM users WHERE username <> ?"
            const snapshot = await firestore.collection('users').where('username', '!=', args[0]).get();
            const batch = firestore.batch();
            snapshot.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
          }
          return callback(null, { affectedRows: 1 });
        }

        // 3. User email check
        if (query.includes('SELECT email FROM users WHERE email=?')) {
          const snapshot = await firestore.collection('users').where('email', '==', args[0]).get();
          const rows = snapshot.docs.map(doc => doc.data());
          return callback(null, rows);
        }

        // 4. User username check
        if (query.includes('SELECT username FROM users WHERE username=?')) {
          const snapshot = await firestore.collection('users').where('username', '==', args[0]).get();
          const rows = snapshot.docs.map(doc => doc.data());
          return callback(null, rows);
        }

        // 5. User registration
        if (query.includes('INSERT into users (username, email,password,wallet,role)')) {
          const user_id = await getNextId('users');
          const newUser = {
            user_id,
            username: args[0],
            email: args[1],
            password: args[2],
            wallet: Number(args[3]),
            role: args[4]
          };
          await firestore.collection('users').doc(String(user_id)).set(newUser);
          return callback(null, { insertId: user_id, affectedRows: 1 });
        }

        // 6. User login profile check (Logical OR query)
        if (query.includes('SELECT * FROM users WHERE email=? or username=?') || 
            query.includes('SELECT * FROM users WHERE email=? OR username=?')) {
          const snapshot = await firestore.collection('users')
            .where(Filter.or(
              Filter.where('email', '==', args[0]),
              Filter.where('username', '==', args[1])
            )).get();
          const rows = snapshot.docs.map(doc => doc.data());
          return callback(null, rows);
        }

        // 7. Get profile by email
        if (query.includes('SELECT user_id, username, email, wallet FROM users WHERE email=?')) {
          const snapshot = await firestore.collection('users').where('email', '==', args[0]).get();
          const rows = snapshot.docs.map(doc => doc.data());
          return callback(null, rows);
        }

        // 8. Bulk insert lotto numbers
        if (uppercaseSql.includes('INSERT INTO LOTTO_NUMBERS (NUMBER) VALUES ?') || 
            uppercaseSql.includes('INSERT INTO LOTTO_NUMBERS(NUMBER) VALUES ?')) {
          const lottoNumbers = args[0]; // [ ['123'], ['456'] ]
          if (Array.isArray(lottoNumbers) && lottoNumbers.length > 0) {
            const batch = firestore.batch();
            const counterRef = firestore.collection('counters').doc('lotto_numbers');
            let currentId = 0;
            const doc = await counterRef.get();
            if (doc.exists) currentId = doc.data().count;

            const insertedIds = [];
            for (let item of lottoNumbers) {
              currentId++;
              const lotto_id = currentId;
              const num = Array.isArray(item) ? item[0] : item;
              const newLotto = {
                lotto_id,
                number: num,
                status: 'available',
                draw_date: null,
                user_id: null
              };
              batch.set(firestore.collection('lotto_numbers').doc(String(lotto_id)), newLotto);
              insertedIds.push(lotto_id);
            }
            await batch.commit();
            await counterRef.set({ count: currentId });
            return callback(null, { insertId: insertedIds[0] || 0, affectedRows: lottoNumbers.length });
          }
        }

        // 9. Select all lotto numbers
        if (query.includes("SELECT number FROM lotto_numbers WHERE status='sold'")) {
          const snapshot = await firestore.collection('lotto_numbers').where('status', '==', 'sold').get();
          const rows = snapshot.docs.map(doc => ({ number: doc.data().number }));
          return callback(null, rows);
        }
        if (query.includes("SELECT number FROM lotto_numbers")) {
          const snapshot = await firestore.collection('lotto_numbers').get();
          const rows = snapshot.docs.map(doc => ({ number: doc.data().number }));
          return callback(null, rows);
        }

        // 10. Check if number exists and not drawn
        if (query.includes('SELECT lotto_id FROM lotto_numbers WHERE number = ? AND (draw_date IS NULL OR draw_date = ?)')) {
          const snapshot = await firestore.collection('lotto_numbers').where('number', '==', args[0]).get();
          let rows = snapshot.docs.map(doc => doc.data());
          if (args[1]) {
            rows = rows.filter(d => !d.draw_date || d.draw_date === args[1]);
          }
          return callback(null, rows);
        }

        // 11. Find winning prize record
        if (query.includes('SELECT id FROM winning_numbers WHERE lotto_id = ? AND prize_rank = ?')) {
          const snapshot = await firestore.collection('winning_numbers')
            .where('lotto_id', '==', args[0])
            .where('prize_rank', '==', args[1]).get();
          const rows = snapshot.docs.map(doc => doc.data());
          return callback(null, rows);
        }

        // 12. Get available lotto tickets
        if (query.includes("SELECT lotto_id, number, price, draw_date FROM lotto_numbers WHERE status = 'available'")) {
          const snapshot = await firestore.collection('lotto_numbers').where('status', '==', 'available').get();
          let rows = snapshot.docs.map(doc => {
            const d = doc.data();
            return {
              lotto_id: d.lotto_id,
              number: d.number,
              price: d.price || 80,
              draw_date: d.draw_date
            };
          });
          if (args[0]) {
            rows = rows.filter(r => !r.draw_date || r.draw_date === args[0]);
          }
          return callback(null, rows);
        }

        // 13. Select user id by email
        if (query.includes('SELECT user_id FROM users WHERE email=?')) {
          const snapshot = await firestore.collection('users').where('email', '==', args[0]).get();
          const rows = snapshot.docs.map(doc => ({ user_id: doc.data().user_id }));
          return callback(null, rows);
        }

        // 14. Check lotto status for purchase locking
        if (query.includes("SELECT lotto_id FROM lotto_numbers WHERE lotto_id=? AND status='available'")) {
          const doc = await firestore.collection('lotto_numbers').doc(String(args[0])).get();
          if (doc.exists && doc.data().status === 'available') {
            return callback(null, [{ lotto_id: doc.data().lotto_id }]);
          }
          return callback(null, []);
        }

        // 15. Check lotto status
        if (query.includes("SELECT status FROM lotto_numbers WHERE lotto_id = ?")) {
          const doc = await firestore.collection('lotto_numbers').doc(String(args[0])).get();
          if (doc.exists) {
            return callback(null, [{ status: doc.data().status }]);
          }
          return callback(null, []);
        }

        // 16. Get user wallet for payment check
        if (query.includes('SELECT user_id, wallet FROM users WHERE email=?')) {
          const snapshot = await firestore.collection('users').where('email', '==', args[0]).get();
          const rows = snapshot.docs.map(doc => ({ user_id: doc.data().user_id, wallet: doc.data().wallet }));
          return callback(null, rows);
        }

        // 17. Update wallet (deduction)
        if (query.includes('UPDATE users SET wallet = wallet - ? WHERE user_id = ?')) {
          const userRef = firestore.collection('users').doc(String(args[1]));
          const doc = await userRef.get();
          if (doc.exists) {
            const currentWallet = doc.data().wallet || 0;
            await userRef.update({ wallet: currentWallet - Number(args[0]) });
          }
          return callback(null, { affectedRows: 1 });
        }

        // 17b. Update lotto to in_cart
        if (query.includes("UPDATE lotto_numbers SET status='in_cart' WHERE lotto_id=?")) {
          const lottoRef = firestore.collection('lotto_numbers').doc(String(args[0]));
          await lottoRef.update({ status: 'in_cart' });
          return callback(null, { affectedRows: 1 });
        }

        // 18. Update lotto ticket ownership to Sold
        if (query.includes("UPDATE lotto_numbers SET status = 'sold', user_id = ? WHERE lotto_id = ?")) {
          const lottoRef = firestore.collection('lotto_numbers').doc(String(args[1]));
          await lottoRef.update({ status: 'sold', user_id: Number(args[0]) });
          return callback(null, { affectedRows: 1 });
        }

        // 19. Record purchase ticket
        if (query.includes('INSERT INTO purchases (user_id, lotto_id, status, purchase_date)')) {
          const purchase_id = await getNextId('purchases');
          const newPurchase = {
            purchase_id,
            user_id: Number(args[0]),
            lotto_id: Number(args[1]),
            status: 'pending',
            purchase_date: new Date().toISOString()
          };
          await firestore.collection('purchases').doc(String(purchase_id)).set(newPurchase);
          return callback(null, { insertId: purchase_id, affectedRows: 1 });
        }

        // 20. Update lotto draw date
        if (query.includes('UPDATE lotto_numbers SET draw_date = ? WHERE lotto_id = ?')) {
          await firestore.collection('lotto_numbers').doc(String(args[1])).update({ draw_date: args[0] });
          return callback(null, { affectedRows: 1 });
        }

        // 21. Record winning number mapping
        if (query.includes('INSERT INTO winning_numbers (prize_amount, prize_rank, lotto_id)')) {
          const id = await getNextId('winning_numbers');
          const newWinning = {
            id,
            prize_amount: Number(args[0]),
            prize_rank: Number(args[1]),
            lotto_id: Number(args[2])
          };
          await firestore.collection('winning_numbers').doc(String(id)).set(newWinning);
          return callback(null, { insertId: id, affectedRows: 1 });
        }

        // 22. SELECT winning numbers JOIN lotto numbers
        if (query.includes('FROM winning_numbers wn') && query.includes('JOIN lotto_numbers ln')) {
          const winningsSnapshot = await firestore.collection('winning_numbers').get();
          const results = [];
          for (let doc of winningsSnapshot.docs) {
            const winData = doc.data();
            const lottoDoc = await firestore.collection('lotto_numbers').doc(String(winData.lotto_id)).get();
            if (lottoDoc.exists) {
              const lottoData = lottoDoc.data();
              if (lottoData.draw_date === args[0]) {
                results.push({
                  number: lottoData.number,
                  prize_amount: winData.prize_amount,
                  prize_rank: winData.prize_rank,
                  lotto_id: winData.lotto_id
                });
              }
            }
          }
          return callback(null, results);
        }

        // 23. SELECT purchases JOIN lotto numbers JOIN users
        if (query.includes('FROM purchases p') && query.includes('JOIN lotto_numbers ln') && query.includes('JOIN users u')) {
          const userSnapshot = await firestore.collection('users').where('email', '==', args[0]).get();
          if (userSnapshot.empty) {
            return callback(null, []);
          }
          const userData = userSnapshot.docs[0].data();
          const purchasesSnapshot = await firestore.collection('purchases').where('user_id', '==', userData.user_id).get();
          const results = [];
          for (let doc of purchasesSnapshot.docs) {
            const pData = doc.data();
            const lottoDoc = await firestore.collection('lotto_numbers').doc(String(pData.lotto_id)).get();
            if (lottoDoc.exists) {
              results.push({
                purchase_id: pData.purchase_id,
                purchase_date: pData.purchase_date,
                status: pData.status,
                lotto_id: pData.lotto_id,
                number: lottoDoc.data().number,
                username: userData.username
              });
            }
          }
          return callback(null, results);
        }

        // 24. Select sold lotto numbers not drawn
        if (query.includes("SELECT lotto_id FROM lotto_numbers WHERE status='sold' AND draw_date IS NULL")) {
          const snapshot = await firestore.collection('lotto_numbers')
            .where('status', '==', 'sold').get();
          const rows = snapshot.docs.map(doc => doc.data()).filter(d => !d.draw_date);
          return callback(null, rows);
        }

        // Fallback for unhandled queries
        console.log("⚠️ UNHANDLED SQL QUERY IN FIREBASE ADAPTER:", query);
        return callback(null, []);
      } catch (err) {
        console.error("🔥 Firebase Adapter Error for Query:", query, err);
        return callback(err, null);
      }
    })();
  },
  promise: function () {
    const parent = this;
    return {
      query: (sql, params) => {
        return new Promise((resolve, reject) => {
          parent.query(sql, params, (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve([result]);
            }
          });
        });
      }
    };
  }
};

const promisePool = db.promise();

// =============== HELPER FUNCTION - FIXED ===============
function queryDatabase(sql, params) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve({
          error: "",
          data: result,
        });
      }
    });
  });
}

// =============== MIDDLEWARE ===============
app.use(bodyParser.json());

// เพิ่ม request timeout
app.use((req, res, next) => {
  req.setTimeout(30000); // 30 วินาที
  res.setTimeout(30000);
  next();
});

app.get("/", (req, res) => {
  console.log("client test defaul path");
  res.send("Hello");
});

app.post("/user/register", async (req, res) => {
  try {
    console.log(req.body.email);
    console.log(req.body.name);
    console.log(req.body.password);
    console.log(req.body.wallet);
    console.log(req.body.role);

    const { name, email, password, wallet, role } = req.body;

    if (!name || name.length < 3) {
      res.send({
        status: "error",
        message: `ชื่อต้องมีความยาวอย่างน้อย 3 ตัวอักษร (คุณกรอกมา ${
          name ? name.length : 0
        } ตัว)`,
      });
      return;
    }
    if (!email || email.length < 4) {
      res.send({
        status: "error",
        message: `อีเมลต้องมีความยาวอย่างน้อย 4 ตัวอักษร (คุณกรอกมา ${
          email ? email.length : 0
        } ตัว)`,
      });
      return;
    }
    if (!password || password.length < 4) {
      res.send({
        status: "error",
        message: `รหัสผ่านต้องมีความยาวอย่างน้อย 4 ตัวอักษร (คุณกรอกมา ${
          password ? password.length : 0
        } ตัว)`,
      });
      return;
    }

    let sqlStr = "SELECT email FROM users WHERE email=?";
    let result = await queryDatabase(sqlStr, [email]);
    if (result.data && result.data.length > 0) {
      res.send({
        status: "error",
        message: "อีเมลนี้ถูกใช้งานแล้ว",
      });
      return;
    }

    let sqlStruser = "SELECT username FROM users WHERE username=?";
    let resultuser = await queryDatabase(sqlStruser, [name]);
    if (resultuser.data && resultuser.data.length > 0) {
      res.send({
        status: "error",
        message: "ชื่อนี้ถูกใช้งานแล้ว",
      });
      return;
    }

    //hash pwd
    const hashPassword = bcrypt.hashSync(password, 8);
    //console.log(hasfPassword);
    const userRole = role || "user";
    sqlStr =
      "INSERT into users (username, email,password,wallet,role)VALUES(?,?,?,?,?)";
    result = await queryDatabase(sqlStr, [name, email, hashPassword, wallet, userRole]);
    if (result["error"] != "") {
      console.log(result.error);

      res.send({
        status: "error",
        message: result["error"].sqlMessage || "Database error",
      });
      return;
    }

    res.send({
      status: "success",
      message: "สมัครสมาชิกสำเร็จ",
    });
  } catch (error) {
    res.send({
      status: "error",
      message: error.message,
    });
    return;
  }
});

app.post("/user/login", async (req, res) => {
  const { email, password } = req.body;
  let emailOrUsername = email;
  if (!emailOrUsername || emailOrUsername.length == 0) {
    return res.send({
      status: "error",
      message: "Email or username is invalid",
    });
  }

  if (!password || password.length == 0) {
    return res.send({
      status: "error",
      message: "Password is invalid",
    });
  }

  if (!emailOrUsername || emailOrUsername.length == 0) {
    res.send({
      status: "error",
      message: "Email or username is invalid",
    });
    return;
  }
  if (!password || password.length == 0) {
    res.send({
      status: "error",
      message: "Password is invid",
    });
    return;
  }

  let sqlStr = "SELECT * FROM users WHERE email=? or username=?";
  let result = await queryDatabase(sqlStr, [emailOrUsername, emailOrUsername]);
  let user = result.data[0];

  if (!result.data || result.data.length === 0) {
    return res.send({
      status: "error",
      message: "อีเมลหรือชื่อผู้ใช้ผิด",
    });
  }
  const passwordIsVaild = bcrypt.compareSync(password, user.password);
  if (!passwordIsVaild) {
    res.send({
      status: "error",
      message: "รหัสผ่านไม่ถูกต้อง",
    });
    return;
  } else {
    const accessToken = jwt.sign(
      { id: user.email, role: user.role },
      ACCESS_TOKEN_SECRET,
      {
        expiresIn: "10h",
      }
    );

    const refreshToken = jwt.sign(
      { id: user.email, role: user.role },
      REFRESH_TOKEN_SECRET,
      {
        expiresIn: "7d",
      }
    );

    res.send({
      status: "success",
      message: "",
      data: {
        accessToken: accessToken,
        refreshToken: refreshToken,
        role: user.role,
        username: user.username,
        userid: user.user_id,
        wallet: user.wallet,
        email: user.email,
      },
    });
    console.log("Logged in user_id:", user.user_id);

    return;
  }
});

app.post("/user/refreshtoken", async (req, res) => {
  const { refreshTokentoken } = req.body;
  if (refreshTokentoken == null || refreshTokentoken.length == 0) {
    res.send({
      status: "error",
      message: "อีเมลหรือชื่อผู้ใช้ผิด",
      data: { accessToken: null, expiresToken: true },
    });
    return;
  }
  try {
    jwt.verify(refreshTokentoken, REFRESH_TOKEN_SECRET, (err, user) => {
      if (err)
        return res.status(403).send({
          status: "error",
          message: "Invild or Expired Refresh Token",
        });

      const accessToken = jwt.sign({ id: user.id }, ACCESS_TOKEN_SECRET, {
        expiresIn: "1h",
      });

      res.send({
        status: "success",
        message: "",
        data: { accessToken: accessToken, expiresToken: false },
      });
      return;
    });
  } catch (error) {
    res.status(500).send({
      status: "error",
      message: "server error",
      data: [],
    });
    return;
  }
});

function authencationToken(req, res, next) {
  let token = req.headers["authorization"];
  console.log(token);
  if (!token) {
    res.status(401).send({
      status: "error",
      message: "Access token invild",
      data: {
        AccessTokenCorrect: false,
      },
    });
    return;
  }
  if (token.startsWith("Bearer ")) {
    token = token.slice(7, token.length);
  }
  jwt.verify(token, ACCESS_TOKEN_SECRET, (err, user) => {
    if (err) {
      res.status(403).send({
        status: "error",
        message: "Access token is expired",
        data: {
          AccessTokenCorrect: false,
        },
      });
      return;
    }
    req.user = user;
    next();
  });
}

app.get("/user/:email", authencationToken, async (req, res) => {
  const { email } = req.params;

  let sqlStr =
    "SELECT user_id, username, email, wallet FROM users WHERE email=?";
  let resultData = await queryDatabase(sqlStr, [email]);
  if (resultData.data[0]) {
    res.send({
      status: "success",
      message: "",
      data: resultData.data[0],
    });
    return;
  } else {
    res.send({
      status: "error",
      message: "not found email",
      data: [],
    });
    return;
  }
});

// Logout endpoint
app.post("/user/logout", (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken || refreshToken.length === 0) {
    return res.status(400).send({
      status: "error",
      message: "Refresh Token is required",
    });
  }

  res.send({
    status: "success",
    message: "Logged out successfully",
  });
});

//keen

// API สำหรับดึงรางวัลตามวันที่ - FIXED FOR FIREBASE
app.post("/lotto/prize", async (req, res) => {
  try {
    const { drawdate } = req.body;
    if (!drawdate) {
      return res.status(400).send({
        status: "error",
        message: "กรุณาส่ง drawdate ด้วย",
      });
    }

    const winningsSnapshot = await firestore.collection('winning_numbers').get();
    const results = [];

    const targetDate = drawdate.split('T')[0];

    for (const doc of winningsSnapshot.docs) {
      const winData = doc.data();
      const lottoDoc = await firestore.collection('lotto_numbers').doc(String(winData.lotto_id)).get();
      if (lottoDoc.exists) {
        const lottoData = lottoDoc.data();
        const lottoDrawDate = lottoData.draw_date ? lottoData.draw_date.split('T')[0] : "";

        if (lottoDrawDate === targetDate) {
          results.push({
            number: lottoData.number,
            prize_amount: winData.prize_amount.toString(),
            prize_rank: winData.prize_rank,
            lotto_id: winData.lotto_id
          });
        }
      }
    }

    results.sort((a, b) => a.prize_rank - b.prize_rank);

    if (results.length === 0) {
      return res.send({
        status: "success",
        message: "ไม่พบผลรางวัลสำหรับวันที่นี้",
        data: [],
      });
    }

    res.send({
      status: "success",
      message: "",
      data: results,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      status: "error",
      message: "เกิดข้อผิดพลาดในการดึงข้อมูล",
    });
  }
});

// API สำหรับตรวจสอบรางวัล - FIXED FOR FIREBASE
app.post("/lotto/checkprize", async (req, res) => {
  try {
    const { number, drawdate, username } = req.body;

    log("ส่งมา number = " + number + " drawdate = " + drawdate + " username = " + username);

    if (!number || !drawdate || !username) {
      return res.status(400).json({
        status: "error",
        message: "ข้อมูลไม่ครบ"
      });
    }

    // 1. Find user by username
    const userSnapshot = await firestore.collection('users').where('username', '==', username).get();
    if (userSnapshot.empty) {
      return res.send({
        status: "error",
        message: "ไม่พบผู้ใช้นี้ในระบบ",
        data: [],
      });
    }
    const userData = userSnapshot.docs[0].data();
    const user_id = userData.user_id;

    // 2. Find purchase history for this user
    const purchasesSnapshot = await firestore.collection('purchases')
      .where('user_id', '==', user_id)
      .where('status', '==', 'purchased')
      .get();

    let userLotto = null;
    const targetDate = drawdate.split('T')[0];

    for (const pDoc of purchasesSnapshot.docs) {
      const pData = pDoc.data();
      const lottoDoc = await firestore.collection('lotto_numbers').doc(String(pData.lotto_id)).get();
      if (lottoDoc.exists) {
        const lottoData = lottoDoc.data();
        const lottoDrawDate = lottoData.draw_date ? lottoData.draw_date.split('T')[0] : "";
        
        if (lottoDrawDate === targetDate && lottoData.number === number) {
          userLotto = {
            purchase_id: pData.purchase_id,
            lotto_id: pData.lotto_id,
            number: lottoData.number,
            status: pData.status
          };
          break;
        }
      }
    }

    if (!userLotto) {
      return res.send({
        status: "error",
        message: "ไม่พบสลากใบนี้ในงวดที่ระบุ",
        data: [],
      });
    }

    // 3. Check if it has winning prize
    const winningsSnapshot = await firestore.collection('winning_numbers')
      .where('lotto_id', '==', userLotto.lotto_id)
      .get();

    if (winningsSnapshot.empty) {
      return res.send({
        status: "success",
        message: "ยังไม่ได้ถูกรางวัล",
        data: [],
      });
    }

    const winningData = [];
    for (const wDoc of winningsSnapshot.docs) {
      const wData = wDoc.data();
      winningData.push({
        number: userLotto.number,
        prize_amount: wData.prize_amount.toString(),
        prize_rank: wData.prize_rank,
        lotto_id: wData.lotto_id
      });
    }

    console.log("ยินดีด้วย ", userLotto.lotto_id);
    return res.send({
      status: "success",
      message: "ยินดีด้วย! ถูกรางวัล",
      data: winningData,
    });
  } catch (error) {
    console.error("Error in checkprize:", error);
    res.status(500).send({
      status: "error",
      message: "เกิดข้อผิดพลาดในการดึงข้อมูล",
    });
  }
});

//////////
app.get("/lotto-admin-sold", authencationToken, async (req, res) => {
  try {
    const { type } = req.query;
    let sqlStr;
    let params = [];

    if (type === "sold") {
      sqlStr = `
        SELECT 
          l.lotto_id,
          l.number AS lotto_number,
          l.price,
          l.status AS purchase_status,
          MAX(w.prize_rank) AS prize_rank,
          DATE_FORMAT(l.draw_date, '%Y-%m-%d') AS draw_date
        FROM lotto_numbers l
        LEFT JOIN winning_numbers w ON l.lotto_id = w.lotto_id
        WHERE l.status = 'sold'
        GROUP BY l.lotto_id, l.number, l.price, l.status, l.draw_date
        ORDER BY l.lotto_id DESC;
      `;
    } else if (type === "available") {
      sqlStr = `
        SELECT
          l.lotto_id,
          l.number AS lotto_number,
          l.price,
          'available' AS purchase_status,
          NULL AS prize_rank,
          DATE_FORMAT(l.draw_date, '%Y-%m-%d') AS draw_date
        FROM lotto_numbers l
        LEFT JOIN purchases p ON l.lotto_id = p.lotto_id
        WHERE p.lotto_id IS NULL
        ORDER BY l.lotto_id
      `;
    } else {
      return res.status(400).json({
        status: "error",
        message: "กรุณาระบุ type=sold หรือ type=available ใน query string",
      });
    }

    const result = await queryDatabase(sqlStr, params);
    console.log(result.data);
    res.json({
      status: "success",
      message: "",
      data: result.data,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: "error",
      message: err.message,
      data: [],
    });
  }
});

//สร้างใบล้อตโต้เพื่อขาย
app.post("/admin/generate-lotto-batch", authencationToken, async (req, res) => {
  try {
    if (!req.user || req.user.role !== "admin") {
      return res
        .status(403)
        .json({ status: "error", message: "Access denied" });
    }

    let { count } = req.body;
    count = parseInt(count, 10) || 100;

    const existing = await queryDatabase(
      "SELECT number FROM lotto_numbers",
      []
    );
    const existingNumbers = new Set(existing.data.map((r) => r.number));
    const lottoNumbers = [];

    while (lottoNumbers.length < count) {
      const number = Math.floor(100000 + Math.random() * 900000).toString();
      if (!existingNumbers.has(number) && !lottoNumbers.includes(number)) {
        lottoNumbers.push(number);
      }
    }
    console.log("Generated lotto numbers:", lottoNumbers);
    const insertValues = lottoNumbers.map((num) => [num]);
    const insertSql = "INSERT INTO lotto_numbers (number) VALUES ?";
    const insertResult = await new Promise((resolve, reject) => {
      db.query(insertSql, [insertValues], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });

    const ids = Array.from(
      { length: lottoNumbers.length },
      (_, i) => i + insertResult.insertId
    );
    const placeholders = ids.map(() => "?").join(",");
    const querySql = `
      SELECT
        lotto_id,
        number AS lotto_number,
        price,
        status AS purchase_status,
        draw_date
      FROM lotto_numbers
      WHERE lotto_id IN (${placeholders})
      ORDER BY lotto_id DESC
    `;
    const lottoData = await queryDatabase(querySql, ids);
    console.log(lottoData.data);

    res.json({
      status: "success",
      message: `สร้างล็อตโต้สำเร็จ ${lottoNumbers.length} ใบ`,
      data: lottoData.data,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

//รีเซทดาต้าเบสจริง
app.post("/reset", authencationToken, async (req, res) => {
  try {
    const adminUsername = "admin1";

    await db.promise().query("DELETE FROM winning_numbers");
    await db.promise().query("DELETE FROM purchases");
    await db.promise().query("DELETE FROM lotto_numbers");
    await db
      .promise()
      .query("DELETE FROM users WHERE username <> ?", [adminUsername]);

    await db
      .promise()
      .query("ALTER TABLE lotto_numbers AUTO_INCREMENT = 1");
    await db.promise().query("ALTER TABLE purchases AUTO_INCREMENT = 1");
    await db
      .promise()
      .query("ALTER TABLE winning_numbers AUTO_INCREMENT = 1");

    res.json({
      status: "success",
      message: "ระบบรีเซ็ตเรียบร้อย เหลือเพียงผู้ดูแลระบบของคุณเท่านั้น",
    });
  } catch (err) {
    console.error("Reset error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// API สุ่มลอตโต้
app.post("/lotto/draw", async (req, res) => {
  try {
    const { fromSold } = req.body;

    let sql = "";
    if (fromSold) {
      sql = "SELECT number FROM lotto_numbers WHERE status='sold'";
    } else {
      sql = "SELECT number FROM lotto_numbers";
    }

    const result = await queryDatabase(sql);
    if (result.error) {
      return res.send({ status: "error", message: result.error.sqlMessage || "Database error" });
    }

    const numbers = result.data;

    if (!numbers || numbers.length === 0) {
      return res.send({ status: "error", message: "ไม่มีเลขลอตเตอรี่สำหรับสุ่ม" });
    }

    const shuffled = numbers.sort(() => 0.5 - Math.random());
    const prizeNumbers = shuffled.slice(0, 3).map((row) => row.number ?? "000000");
    const [prize1, prize2, prize3] = prizeNumbers;

    const prize4 = (prize1 ?? "000000").slice(-3);

    const allNums = numbers.map((row) => row.number ?? "00");
    const randomNumber = allNums[Math.floor(Math.random() * allNums.length)];
    const prize5 = (randomNumber ?? "00").slice(-2);

    res.send({
      status: "success",
      data: { prize1, prize2, prize3, prize4, prize5 },
    });
  } catch (error) {
    res.send({ status: "error", message: error.message });
  }
});

/////////////////////////////////////////////////////////////////////
function queryDatabaseStrict(sql, params) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

app.post("/lotto/save", async (req, res) => {
  console.log("body received:", req.body);
  const { draw_date, prizes } = req.body;

  if (!prizes || Object.keys(prizes).length === 0) {
    return res.send({ status: "error", message: "ข้อมูลรางวัลไม่ครบ" });
  }

  try {
    // Fetch all lotto numbers from Firestore to do the matching
    const lottoSnapshot = await firestore.collection('lotto_numbers').get();
    const allLottos = lottoSnapshot.docs.map(doc => doc.data());

    const batch = firestore.batch();
    const lottoIdsToUpdate = new Set();
    const winningRecords = [];

    for (const rank of Object.keys(prizes)) {
      const prizeRank = parseInt(rank, 10);
      const prizeNumber = prizes[rank].number.toString();
      const prizeAmount = Number(prizes[rank].amount);

      // Find matching lottos
      let matches = [];
      if (prizeRank === 1 || prizeRank === 2 || prizeRank === 3) {
        matches = allLottos.filter(l => l.number === prizeNumber);
      } else if (prizeRank === 4 || prizeRank === 5) {
        matches = allLottos.filter(l => l.number && l.number.endsWith(prizeNumber));
      }

      if (matches.length === 0) {
        console.log(`No matching lotto found for prize rank ${prizeRank} (${prizeNumber})`);
        if (prizeRank <= 3) {
          return res.send({
            status: "error",
            message: `เลข ${prizeNumber} ไม่พบในระบบ`,
          });
        }
      }

      for (const lotto of matches) {
        lottoIdsToUpdate.add(lotto.lotto_id);
        winningRecords.push({
          lotto_id: lotto.lotto_id,
          prize_rank: prizeRank,
          prize_amount: prizeAmount
        });
      }
    }

    // Update draw_date on matching lottos
    for (const lottoId of lottoIdsToUpdate) {
      batch.update(firestore.collection('lotto_numbers').doc(String(lottoId)), { draw_date });
    }

    // Save winning numbers
    for (const rec of winningRecords) {
      const winQuery = await firestore.collection('winning_numbers')
        .where('lotto_id', '==', rec.lotto_id)
        .where('prize_rank', '==', rec.prize_rank)
        .get();

      if (winQuery.empty) {
        const nextWinId = await getNextId('winning_numbers');
        batch.set(firestore.collection('winning_numbers').doc(String(nextWinId)), {
          id: nextWinId,
          lotto_id: rec.lotto_id,
          prize_rank: rec.prize_rank,
          prize_amount: rec.prize_amount
        });
      } else {
        const existingDocId = winQuery.docs[0].id;
        batch.update(firestore.collection('winning_numbers').doc(existingDocId), {
          prize_amount: rec.prize_amount
        });
      }
    }

    await batch.commit();
    res.send({ status: "success", message: "บันทึกผลรางวัลเรียบร้อย" });
  } catch (error) {
    console.error("Save lotto error:", error);
    res.send({ status: "error", message: error.message });
  }
});

//////////////////////////////////////ot/////////////////////////////////////

app.get("/lotto", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT lotto_id, number, price, draw_date FROM lotto_numbers WHERE status = 'available' 
      and draw_date is null`
    );
    res.json({ success: true, data: rows || [] });
    console.log("Lotto rows:", rows);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------- GET PURCHASE HISTORY - FIXED FOR FIREBASE ----------------
app.get("/api/purchases/:user_id", authencationToken, async (req, res) => {
  console.log("===== GET PURCHASE HISTORY START =====");

  const tokenEmail = req.user.id;
  const paramUserId = parseInt(req.params.user_id, 10);

  if (isNaN(paramUserId)) {
    return res.status(400).json({ success: false, message: "Invalid user_id parameter" });
  }

  try {
    // Get user by email from token
    const userSnapshot = await firestore.collection('users').where('email', '==', tokenEmail).get();
    if (userSnapshot.empty) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const userData = userSnapshot.docs[0].data();

    // Get purchased tickets for this user
    const purchasesSnapshot = await firestore.collection('purchases')
      .where('user_id', '==', userData.user_id)
      .where('status', '==', 'purchased')
      .get();

    if (purchasesSnapshot.empty) {
      return res.json({ success: true, purchases: [] });
    }

    const purchasesMap = new Map();

    for (const pDoc of purchasesSnapshot.docs) {
      const pData = pDoc.data();
      const lottoId = pData.lotto_id;

      // Get lotto details
      const lottoDoc = await firestore.collection('lotto_numbers').doc(String(lottoId)).get();
      const lottoData = lottoDoc.exists ? lottoDoc.data() : {};

      // Get winning numbers for this lotto
      const winningsSnapshot = await firestore.collection('winning_numbers')
        .where('lotto_id', '==', lottoId)
        .get();

      const prizes = [];
      for (const wDoc of winningsSnapshot.docs) {
        const wData = wDoc.data();
        prizes.push({
          prize_rank: wData.prize_rank,
          prize_amount: wData.prize_amount,
          lotto_status: lottoData.status || null,
        });
      }

      // Sort prizes by rank
      prizes.sort((a, b) => (a.prize_rank || 0) - (b.prize_rank || 0));

      purchasesMap.set(lottoId, {
        purchase_id: pData.purchase_id,
        user_id: pData.user_id,
        lotto_id: lottoId,
        lotto_number: lottoData.number || null,
        lotto_price: lottoData.price || 80,
        draw_date: lottoData.draw_date || null,
        lotto_status: lottoData.status || null,
        purchase_date: pData.purchase_date || null,
        purchase_status: pData.status,
        cashout_date: pData.cashout_date || null,
        prize_rank: prizes.length > 0 ? prizes[0].prize_rank : null,
        prize_amount: prizes.length > 0 ? prizes[0].prize_amount : null,
        prizes: prizes,
      });
    }

    const groupedPurchases = Array.from(purchasesMap.values());
    // Sort by purchase_date desc
    groupedPurchases.sort((a, b) => {
      const dateA = a.purchase_date ? new Date(a.purchase_date) : new Date(0);
      const dateB = b.purchase_date ? new Date(b.purchase_date) : new Date(0);
      return dateB - dateA;
    });

    res.json({ success: true, purchases: groupedPurchases });
    console.log("Response sent successfully. Purchases count:", groupedPurchases.length);
  } catch (err) {
    console.error("Error fetching purchase history:", err);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงข้อมูลประวัติ" });
  }

  console.log("===== GET PURCHASE HISTORY END =====");
});

/////////////////////CREATE PURCHASE (เลือกหวย) - FIXED FOR FIREBASE
app.post("/api/purchases", authencationToken, async (req, res) => {
  try {
    const { lotto_id } = req.body;
    if (!lotto_id) {
      return res.status(400).json({ success: false, message: "Missing lotto_id" });
    }

    // Get user_id from email
    const [u] = await promisePool.query("SELECT user_id FROM users WHERE email=?", [req.user.id]);
    if (!u || u.length === 0) {
      return res.status(401).json({ success: false, message: "Unauthorized user" });
    }
    const user_id = u[0] ? u[0].user_id : u.user_id;

    // Check lotto availability
    const [lrows] = await promisePool.query(
      "SELECT lotto_id FROM lotto_numbers WHERE lotto_id=? AND status='available'",
      [lotto_id]
    );
    if (!lrows || (Array.isArray(lrows) && lrows.length === 0)) {
      return res.status(400).json({ success: false, message: "หวยนี้ถูกเลือก/ขายไปแล้ว" });
    }

    // Update lotto status to in_cart
    await promisePool.query("UPDATE lotto_numbers SET status='in_cart' WHERE lotto_id=?", [lotto_id]);

    // Create purchase record
    const [pres] = await promisePool.query(
      "INSERT INTO purchases (user_id, lotto_id, status, purchase_date) VALUES (?, ?, 'pending', NOW())",
      [user_id, lotto_id]
    );

    return res.json({ success: true, data: { purchase_id: pres.insertId || 0 } });

  } catch (err) {
    console.error("POST /api/purchases error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


///////////////////GET CART (เฉพาะ pending) - FIXED FOR FIREBASE
app.get("/api/cart", authencationToken, async (req, res) => {
  try {
    // Get user
    const userSnapshot = await firestore.collection('users').where('email', '==', req.user.id).get();
    if (userSnapshot.empty) {
      return res.json({ success: true, data: [] });
    }
    const user_id = userSnapshot.docs[0].data().user_id;

    // Get pending purchases
    const purchasesSnapshot = await firestore.collection('purchases')
      .where('user_id', '==', user_id)
      .where('status', '==', 'pending')
      .get();

    const rows = [];
    for (const pDoc of purchasesSnapshot.docs) {
      const pData = pDoc.data();
      const lottoDoc = await firestore.collection('lotto_numbers').doc(String(pData.lotto_id)).get();
      if (lottoDoc.exists && lottoDoc.data().status === 'in_cart') {
        const lData = lottoDoc.data();
        rows.push({
          purchase_id: pData.purchase_id,
          lotto_id: lData.lotto_id,
          number: lData.number,
          price: lData.price || 80,
          draw_date: lData.draw_date
        });
      }
    }

    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

////////// CANCEL PURCHASE - FIXED FOR FIREBASE
app.patch("/api/purchases/:id/cancel", authencationToken, async (req, res) => {
  try {
    const pid = Number(req.params.id) || 0;
    if (!pid) return res.status(400).json({ success: false, message: "Missing purchase_id" });

    // Get user_id
    const userSnapshot = await firestore.collection('users').where('email', '==', req.user.id).get();
    if (userSnapshot.empty) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const user_id = userSnapshot.docs[0].data().user_id;

    // Find purchase
    const purchaseDoc = await firestore.collection('purchases').doc(String(pid)).get();
    if (!purchaseDoc.exists || purchaseDoc.data().user_id !== user_id) {
      return res.status(404).json({ success: false, message: "ไม่พบรายการของคุณ" });
    }
    if (purchaseDoc.data().status !== 'pending') {
      return res.status(400).json({ success: false, message: "ยกเลิกได้เฉพาะ pending" });
    }

    const lotto_id = purchaseDoc.data().lotto_id;

    // Update purchase status to cancelled
    await firestore.collection('purchases').doc(String(pid)).update({ status: 'cancelled' });
    // Update lotto back to available
    await firestore.collection('lotto_numbers').doc(String(lotto_id)).update({ status: 'available' });

    res.json({ success: true, message: "ยกเลิกสำเร็จ" });
  } catch (err) {
    console.error("CANCEL error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// CHECKOUT - FIXED FOR FIREBASE
app.post("/api/checkout", authencationToken, async (req, res) => {
  try {
    // Get user
    const userSnapshot = await firestore.collection('users').where('email', '==', req.user.id).get();
    if (userSnapshot.empty) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const userDoc = userSnapshot.docs[0];
    const userData = userDoc.data();
    const user_id = userData.user_id;
    const walletBefore = Number(userData.wallet ?? 0);

    // Get pending purchases for this user
    const purchasesSnapshot = await firestore.collection('purchases')
      .where('user_id', '==', user_id)
      .where('status', '==', 'pending')
      .get();

    if (purchasesSnapshot.empty) {
      return res.status(400).json({ success: false, message: "ไม่มีรายการในตะกร้า" });
    }

    // Build cart with lotto prices
    const cart = [];
    for (const pDoc of purchasesSnapshot.docs) {
      const pData = pDoc.data();
      const lottoDoc = await firestore.collection('lotto_numbers').doc(String(pData.lotto_id)).get();
      if (lottoDoc.exists && lottoDoc.data().status === 'in_cart') {
        cart.push({
          purchase_id: pData.purchase_id,
          lotto_id: pData.lotto_id,
          price: Number(lottoDoc.data().price || 80)
        });
      }
    }

    if (cart.length === 0) {
      return res.status(400).json({ success: false, message: "ไม่มีรายการในตะกร้า" });
    }

    const total = cart.reduce((sum, r) => sum + r.price, 0);

    if (walletBefore < total) {
      return res.status(400).json({
        success: false,
        message: "ยอดเงินไม่พอ",
        wallet_before: walletBefore,
        total_needed: total
      });
    }

    // Update all purchases to 'purchased' and lottos to 'sold'
    const batch = firestore.batch();
    for (const item of cart) {
      batch.update(firestore.collection('purchases').doc(String(item.purchase_id)), { status: 'purchased' });
      batch.update(firestore.collection('lotto_numbers').doc(String(item.lotto_id)), { status: 'sold', user_id: user_id });
    }
    // Deduct wallet
    const walletAfter = walletBefore - total;
    batch.update(firestore.collection('users').doc(String(user_id)), { wallet: walletAfter });
    await batch.commit();

    return res.json({
      success: true,
      message: "ชำระเงินสำเร็จ",
      purchased_count: cart.length,
      total_paid: total,
      wallet_before: walletBefore,
      wallet_after: walletAfter
    });
  } catch (err) {
    console.error("POST /api/checkout error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

//////////////////////////////keeen//////////////////////////////

// CLAIM PRIZE - FIXED FOR FIREBASE
app.post("/api/claim-prize", authencationToken, async (req, res) => {
  console.log("===== CLAIM PRIZE START =====");

  try {
    const { lotto_id } = req.body;
    const email = req.user.id;

    console.log("Email from token:", email);
    console.log("Lotto ID to claim:", lotto_id);

    if (!lotto_id) {
      return res.status(400).json({
        success: false,
        message: "Missing lotto_id"
      });
    }

    // Get user data
    const userSnapshot = await firestore.collection('users').where('email', '==', email).get();
    if (userSnapshot.empty) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const userDoc = userSnapshot.docs[0];
    const userData = userDoc.data();

    // Check purchase exists
    const purchasesSnapshot = await firestore.collection('purchases')
      .where('user_id', '==', userData.user_id)
      .where('lotto_id', '==', Number(lotto_id))
      .where('status', '==', 'purchased')
      .get();

    if (purchasesSnapshot.empty) {
      return res.status(404).json({
        success: false,
        message: "ไม่พบการซื้อหวยนี้หรือยังไม่ได้ชำระเงิน"
      });
    }

    const purchaseData = purchasesSnapshot.docs[0].data();
    console.log("Purchase found:", purchaseData);

    // Check if already cashed
    const lottoDoc = await firestore.collection('lotto_numbers').doc(String(lotto_id)).get();
    if (lottoDoc.exists && lottoDoc.data().status === 'cashed') {
      return res.status(400).json({
        success: false,
        message: "เคยขึ้นเงินรางวัลนี้แล้ว"
      });
    }

    // Get winning numbers for this lotto
    const winningsSnapshot = await firestore.collection('winning_numbers')
      .where('lotto_id', '==', Number(lotto_id))
      .get();

    if (winningsSnapshot.empty) {
      return res.status(400).json({
        success: false,
        message: "หวยใบนี้ไม่ได้ถูกรางวัล"
      });
    }

    // Calculate total prize
    let totalPrizeAmount = 0;
    const prizeDetails = [];
    for (const doc of winningsSnapshot.docs) {
      const winData = doc.data();
      const prizeAmount = parseFloat(winData.prize_amount);
      totalPrizeAmount += prizeAmount;
      prizeDetails.push({
        prize_rank: winData.prize_rank,
        prize_amount: prizeAmount
      });
    }

    const currentWallet = parseFloat(userData.wallet);
    const newWallet = currentWallet + totalPrizeAmount;

    console.log(`Total prize amount: ${totalPrizeAmount}, Current wallet: ${currentWallet}, New wallet: ${newWallet}`);

    // Update wallet, lotto status, and purchase cashout_date
    const batch = firestore.batch();
    batch.update(firestore.collection('users').doc(String(userData.user_id)), { wallet: newWallet });
    batch.update(firestore.collection('lotto_numbers').doc(String(lotto_id)), { status: 'cashed' });
    batch.update(firestore.collection('purchases').doc(String(purchaseData.purchase_id)), {
      cashout_date: new Date().toISOString()
    });
    await batch.commit();

    console.log("Prize claimed successfully");

    const lottoNumber = lottoDoc.exists ? lottoDoc.data().number : "";

    res.json({
      success: true,
      message: "ขึ้นเงินรางวัลสำเร็จ",
      data: {
        total_prize_amount: totalPrizeAmount,
        wallet_before: currentWallet,
        wallet_after: newWallet,
        prizes: prizeDetails,
        lotto_number: lottoNumber,
        prizes_count: prizeDetails.length
      }
    });

  } catch (err) {
    console.error("Error in claim prize:", err);
    res.status(500).json({
      success: false,
      message: "เกิดข้อผิดพลาดในการขึ้นเงินรางวัล"
    });
  }

  console.log("===== CLAIM PRIZE END =====");
});

// =============== START SERVER ===============
app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
  console.log(`🌐 Server IP: ${ip}:${port}`);
});

// =============== GRACEFUL SHUTDOWN ===============
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  db.end((err) => {
    if (err) {
      console.error('Error closing database pool:', err);
    } else {
      console.log('Database pool closed');
    }
    process.exit(err ? 1 : 0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  db.end((err) => {
    if (err) {
      console.error('Error closing database pool:', err);
    } else {
      console.log('Database pool closed');
    }
    process.exit(err ? 1 : 0);
  });
});