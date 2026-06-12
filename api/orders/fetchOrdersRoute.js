const express = require("express");
const router = express.Router();
const zingoPool = require("../../database/pgZingo");
const multer = require('multer');
const {uploadFileToS3, deleteFileFromS3, moveFileInS3} = require("../../database/s3")
const authenticateFirebaseToken = require("../../auth/authFirebaseToken")
const axios = require('axios');
const { generateAndUpdateProductTags } = require("../../helper/productRoutesHelper/addTagHelper");
const createRateLimiterMiddleware = require("../rateLimiter");



module.exports = router