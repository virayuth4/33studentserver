const { default: axios } = require("axios");
const express = require("express");
const router = express.Router();
const cheerio = require('cheerio');


function parseProductInfoFromCaption(caption) {
    const result = {
      name: '',
      price: '',
      description: '',
      category: ''
    };
    
    // Clean up caption - remove hashtags and excess whitespace
    const cleanCaption = caption.replace(/#\w+/g, '').trim();
    const lines = cleanCaption.split('\n').filter(line => line.trim());
    
    // First line is likely the product name
    if (lines.length > 0) {
      result.name = lines[0].trim();
    }
    
    // Look for price patterns
    const pricePattern = /(\$|USD|KHR|៛|price:?)\s*([0-9,.]+)/i;
    const priceMatch = caption.match(pricePattern);
    if (priceMatch) {
      result.price = priceMatch[2];
    }
    
    // Look for common category indicators
    const categoryKeywords = [
      'category:', 'type:', 'style:', 'collection:'
    ];
    
    lines.forEach(line => {
      // Check for category keywords
      categoryKeywords.forEach(keyword => {
        if (line.toLowerCase().includes(keyword)) {
          const categoryPart = line.split(keyword)[1];
          if (categoryPart) {
            result.category = categoryPart.trim();
          }
        }
      });
    });
    
    // Combine remaining lines as description
    if (lines.length > 1) {
      result.description = lines.slice(1).join('\n');
    }
    
    return result;
  }

  router.post("/import/instagram", async (req, res) => {
    try {
      console.log("=====Import Instagram Link Url Hit=====");
      const { url } = req.body;
      console.log("Instagram Url", url);
      
      if (!url || !url.includes('instagram.com')) {
        return res.status(400).json({ message: "Invalid Instagram Url" });
      }
  
      // Ensure URL has the correct protocol
      let formattedUrl = url;
      if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
        formattedUrl = 'https://' + formattedUrl;
      }
  
      const response = await axios.get(formattedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Referer': 'https://www.instagram.com/',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        },
        timeout: 10000 // 10 seconds timeout
      });
      
      const html = response.data;
      const $ = cheerio.load(html);
  
      // Extract image urls
      const images = [];
      $('meta[property="og:image"]').each((i, element) => {
        const imageUrl = $(element).attr('content');
        if (imageUrl) images.push(imageUrl);
      });
  
      // Better caption extraction - try multiple approaches
      let caption = '';
      
      // Approach 1: Try og:description meta tag
      const ogDescription = $('meta[property="og:description"]').attr('content');
      if (ogDescription) {
        // Split by '•' and take the first part, which is typically the caption
        const parts = ogDescription.split('•');
        if (parts.length > 0) {
          caption = parts[0].trim();
        } else {
          caption = ogDescription;
        }
        
        // Remove Instagram boilerplate text
        caption = caption.replace(/\s+on Instagram:?\s*"/, '').replace(/"$/, '');
      }
      
      // Approach 2: Look for structured data
      if (!caption) {
        const scriptTags = $('script[type="application/ld+json"]');
        scriptTags.each((i, element) => {
          try {
            const jsonData = JSON.parse($(element).html());
            if (jsonData && jsonData.caption) {
              caption = jsonData.caption;
            }
          } catch (e) {
            // Ignore parse errors
          }
        });
      }
      
      // Approach 3: Look for specific Instagram post content
      if (!caption) {
        const postContent = $('.C4VMK .C4VMK span').text();
        if (postContent) {
          caption = postContent;
        }
      }
      
      // Approach 4: Try additional selectors (Instagram changes their HTML structure frequently)
      if (!caption) {
        caption = $('div._a9zs').text() || 
                 $('div.C4VMK').text() || 
                 $('div._a9zr').text() || 
                 $('div.xil3uk').text() ||
                 $('meta[name="description"]').attr('content') || '';
      }
      
      // Clean up caption
      caption = caption
        .replace(/\s+on Instagram:?\s*"/, '')
        .replace(/"$/, '')
        .replace(/^"/, '')
        .trim();
      
      console.log("Extracted Caption:", caption);
  
      // Extract product information from caption
      const productInfo = parseProductInfoFromCaption(caption);
      console.log("Product Info:", productInfo);
  
      // Download images (up to 5)
      const downloadedImages = [];
      for (let i = 0; i < Math.min(images.length, 5); i++) {
        const imageUrl = images[i];
        const imagePath = await downloadImage(imageUrl);
        if (imagePath) {
          downloadedImages.push({
            originalUrl: imageUrl,
            localPath: imagePath,
            url: `/uploads/${path.basename(imagePath)}`
          });
        }
      }
      
      // Send successful response
      return res.json({
        success: true,
        data: {
          caption,
          productInfo,
          images: downloadedImages
        }
      });
      
    } catch (error) {
      console.error("Instagram import error:", error);
      return res.status(500).json({ 
        success: false, 
        message: "Failed to import Instagram post", 
        error: error.message 
      });
    }
  });

module.exports = router;