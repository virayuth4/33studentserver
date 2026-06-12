
const express = require('express');
const cors = require('cors');
const { admin, auth, db } = require('./auth/firebase-admin');
const config = require('./config/config')
const { testS3Connection } = require('./database/s3');
const cron = require('node-cron');

require('dotenv').config();



const initializeDatabases = require('./database/pgInit')

const adminRoutes = require('./admin/adminRoutes')
const adminOrderRoutes = require('./admin/orders/adminOrderRoutes')
const adminProductRoutes = require('./admin/products/adminProductRoutes')
const adminDriverRoutes = require('./admin/drivers/adminDriverRoutes')


const postAndEditProductRoute = require("./api/products/postAndEditProductRoute")
const deleteProductRoute = require('./api/products/deleteProductRoute')

const fetchOfferRoute = require("./api/offers/fetchOfferRoute")
const postOfferRoute = require("./api/offers/postOfferRoute")

const fetchUserPostRoute = require("./api/user/fetchUserPostRoute")

const postRefundRequestRoutes = require('./api/refund/postRefundRequestRoutes')
const fetchRefundProductRoutes = require('./api/refund/fetchRefundProductRoutes')

const flutterSupportRoute = require("./api/flutter/support/flutterSupportRoutes")

const trackUserSession = require('./auth/sessionTracker');


const userRoutes = require('./api/userRoutes')
const testRoutes = require('./api/testRoutes')
const productRoutes = require('./api/productRoutes')
const userPostRoutes = require('./api/userPostRoutes')
const orderRoutes = require('./api/orderRoutes')
const commentsAndRatingsRoutes = require('./api/commentsAndRatingsRoutes')
const slugRoutes = require('./api/slugRoutes')
const storesRoutes = require('./api/stores/storesRoutes')
const eventTrackerRoutes = require('./api/eventTrackers/eventsTrackerBatch');
const careerRoutes = require('./api/career/careerRoutes');

//Import routes for 33 students ======
const studentUserRoutes = require('./api/user/33studentUserRoutes');
const studentProductRoutes = require('./api/products/33productRoute');
const studentCartRoutes = require('./api/cart/cartRoutes');
const studentDealsRoutes = require('./api/deals/dealsRoutes');

//====================Import Routes for Flutter====================
const flutterUserRoutes = require('./api/flutter/user/flutterUserRoutes');
// const flutterPostUserRoutes = require("./api/flutter/user/flutterPostUserRoutes");
const flutterFetchProductRoutes = require('./api/flutter/products/flutterFetchProductRoutes');
const flutterPostOrderRoutes = require('./api/flutter/orders/flutterPostOrderRoutes');
const flutterPostProductRoutes = require("./api/flutter/products/flutterPostProductRoutes");
const flutterFetchOrderRoutes = require("./api/flutter/orders/flutterFetchOrderRoutes");
const flutterAdminOrderRoutes = require("./api/flutter/orders/flutterAdminOrderRoutes");

const flutterSellerApplicationRoutes = require("./admin/applications/seller_application");
const flutterSupportRoutes = require("./api/flutter/support/flutterSupportRoutes");

const accountRegisterWithPhoneOtp = require("./api/auth/register/accountRegisterWithPhoneOtp");
const instagramRoutes = require("./api/instagram/instagramRoutes")
const { deleteExpiredOTPs } = require('./utils/cleanup/deleteExpiredOTPs');
const userSessionsRoutes = require('./api/sessions/sessionsRoutes');


//===============================================================Import ROutes for Vintage
const vintageFetchProductRoute = require('./api/vintage/vintageFetchProductRoute')
const _1464EventTrackerRoutes = require ('./api/vintage/1464EventTrackerRoutes')
const _1464CheckoutRoutes = require('./api/vintage/1464CheckoutRoutes')
const _1464OrderRoutes = require('./api/vintage/1464OrderRoutes')
const _1464AdminOrderRoutes = require('./api/vintage/1464AdminOrderRoutes')
const _1464RefundRoutes = require('./api/vintage/1464RefundRoutes')

//===============================================================Import Routes for vmall
const vmallProductRoutes = require('./api/vmall/vmallProductRoutes')


// CORS configuration
const corsOptions = {
  origin: config.CORS_ORIGINS,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'x-client-type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    '*',
  ],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  credentials: true,
  maxAge: 86400,
  preflightContinue: false,
  optionsSuccessStatus: 204
};


const app = express();
// app.use((req, res, next) => {
//   console.log('Request received from origin:', req.headers.origin);
//   console.log('Request path:', req.path);
//   console.log('Request method:', req.method);
//   console.log('Headers:', JSON.stringify(req.headers, null, 2));
//   console.log('Allowed Origins:', config.CORS_ORIGINS);
//   next();
// });
app.use(cors(corsOptions));
app.use(express.json());

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nDisallow:'); // or your preferred robots.txt content
});

app.get('/sitemap.xml', (req, res) => {
  res.status(404).send('Not Found'); // or serve actual sitemap
});

app.get('/favicon.ico', (req, res) => {
  res.status(404).send('Not Found'); // or serve actual favicon
});


// app.use('/', (req, res, next) => {
//   console.log('Request received from origin:', req.headers.origin);
//   console.log('Request path:', req.path);
//   console.log('Request method:', req.method);
//   console.log('Headers:', JSON.stringify(req.headers, null, 2));
//   console.log('Allowed Origins:', config.CORS_ORIGINS);
//   next();
// });
app.use('/api', trackUserSession);
//===================For Flutter App================
app.use('/api/flutter', flutterUserRoutes)
// app.use('/api/flutter', flutterPostUserRoutes);
app.use('/api/flutter',flutterFetchProductRoutes)
app.use('/api/flutter', flutterPostOrderRoutes)
app.use('/api/flutter', flutterPostProductRoutes);
app.use('/api/flutter', flutterFetchOrderRoutes);
app.use('/api/flutter',flutterAdminOrderRoutes);
app.use('/api/flutter', flutterSellerApplicationRoutes );

app.use('/api',accountRegisterWithPhoneOtp)
app.use('/api/flutter', flutterSupportRoutes)

//===================================================

app.use('/api',adminRoutes)
app.use('/api',adminOrderRoutes)
app.use('/api',adminProductRoutes)
app.use('/api',adminDriverRoutes)

app.use('/api', postAndEditProductRoute)
app.use('/api', postOfferRoute)
app.use('/api', deleteProductRoute)

app.use('/api', postOfferRoute)
app.use('/api', fetchOfferRoute)

app.use('/api', fetchUserPostRoute)

app.use('/api', postRefundRequestRoutes)
app.use('/api', fetchRefundProductRoutes)

app.use('/api', userRoutes)
app.use('/api', testRoutes)
app.use('/api', productRoutes)
app.use('/api', userPostRoutes)
app.use('/api', orderRoutes)
app.use('/api', commentsAndRatingsRoutes)

app.use('/api', instagramRoutes)
app.use('/api', storesRoutes)
app.use('/api', eventTrackerRoutes)
app.use('/api', careerRoutes);
app.use('/api', userSessionsRoutes);


//===================Vintage Products Route========================
app.use('/api', vintageFetchProductRoute) //this is also 1464
app.use('/api', _1464EventTrackerRoutes)
app.use('/api', _1464CheckoutRoutes)
app.use('/api', _1464OrderRoutes)
app.use('/api', _1464AdminOrderRoutes)
app.use('/api', _1464RefundRoutes)

//=================Vmall Products Route========================
app.use('/api', vmallProductRoutes)

//=================33 students route ============
app.use('/api', studentUserRoutes)
app.use('/api', studentProductRoutes)
app.use('/api', studentCartRoutes)
app.use('/api', studentDealsRoutes)

app.use('/product', slugRoutes) //Slug route uses '/prducts' instead of '/api'

const isProduction = 'production';



app.get('/health', (req, res) => {
  res.json({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: Date.now()
  });
});



async function startServer() {
  const PORT = 9000
  const isProductionTest = config.isProductionTest?.() || false;

  console.log('\n🚀 Starting server...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🔧 Environment: ${process.env.NODE_ENV}${isProductionTest ? ' (Production Test)' : ''}`);
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🔌 Backend URL: ${process.env.NEXT_PUBLIC_BACKEND || 'Not set'}`);

//   cron.schedule('* * * * *', () => {
//     console.log('Running cleanup task...');
//     deleteExpiredOTPs();
// });

  try {
    const s3Connected = await testS3Connection();
    if (s3Connected) {
      console.log("S3 bucket is configured correctly")
    }
  } catch (error) {
    console.error("S3 bucket configuration failed")
  }

  initializeDatabases().catch(console.error);

  app.listen(PORT,'0.0.0.0', () => {
    console.log(`Server is running on port: ${PORT}`),
    console.log(`Environment: ${process.env.NODE_ENV}`)
    console.log('Client:', process.env.NEXT_PUBLIC_BACKEND)
  })

 

}

startServer()