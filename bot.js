const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const cheerio = require('cheerio');
const { finalizeEvent, getPublicKey } = require('nostr-tools');
const { Relay } = require('nostr-tools/relay');

// --- LOAD CONFIGURATION FROM CONFIG.JSON ---
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = {};

try {
    const fileData = fs.readFileSync(CONFIG_FILE, 'utf8');
    config = JSON.parse(fileData);
} catch (err) {
    console.error('Error reading config.json:', err.message);
    process.exit(1);
}

const PRIVATE_KEY_HEX = config.private_key_hex;
const CHANNELS = config.channels || [];
const BLOSSOM_SERVER_URL = config.blossom_server_url || 'https://blossom.primal.net';
const RELAY_URLS = config.relay_urls || [];

const STATE_FILE = path.join(__dirname, 'sent_posts.json');

// --- LOAD PERSISTENT STATE ---
let sentPosts = new Set();
if (fs.existsSync(STATE_FILE)) {
    try {
        const fileData = fs.readFileSync(STATE_FILE, 'utf8');
        const parsedData = JSON.parse(fileData);
        if (Array.isArray(parsedData)) {
            sentPosts = new Set(parsedData);
            console.log(`Loaded ${sentPosts.size} previously sent posts from disk.`);
        }
    } catch (err) {
        console.error('Error reading state file, starting with empty set:', err.message);
    }
}

// --- SAVE PERSISTENT STATE ---
function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(Array.from(sentPosts), null, 2));
    } catch (err) {
        console.error('Error saving state file:', err.message);
    }
}

// --- BLOSSOM UPLOAD HELPER ---
async function uploadToBlossom(imageUrl) {
    try {
        console.log(`Downloading image from Telegram: ${imageUrl}`);
        
        const imageResponse = await axios.get(imageUrl, { 
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const fileBuffer = Buffer.from(imageResponse.data);
        const contentType = imageResponse.headers['content-type'] || 'image/jpeg';

        const sha256Hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

        let privKeyBytes = Uint8Array.from(Buffer.from(PRIVATE_KEY_HEX, 'hex'));
        const uploadUrl = `${BLOSSOM_SERVER_URL}/upload`;
        
        const authEventTemplate = {
            kind: 27235,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['u', uploadUrl],
                ['method', 'PUT'],
                ['payload', sha256Hash]
            ],
            content: ''
        };
        const signedAuthEvent = finalizeEvent(authEventTemplate, privKeyBytes);
        const encodedAuth = Buffer.from(JSON.stringify(signedAuthEvent)).toString('base64');

        console.log(`Uploading to Blossom server (${BLOSSOM_SERVER_URL})...`);
        const response = await axios.put(uploadUrl, fileBuffer, {
            headers: {
                'Authorization': `Nostr ${encodedAuth}`,
                'Content-Type': contentType
            }
        });

        const uploadedUrl = response.data?.url || response.data?.nip98_url || (response.data?.sha256 ? `${BLOSSOM_SERVER_URL}/${response.data.sha256}` : null);
        
        if (uploadedUrl) {
            console.log(`Successfully uploaded image to Blossom: ${uploadedUrl}`);
            return uploadedUrl;
        } else {
            console.error('Blossom server response did not include a valid URL:', response.data);
        }
    } catch (err) {
        console.error('Failed to upload image to Blossom server:', err.response?.data || err.message);
    }
    return null;
}

async function checkTelegramAndPost() {
    let stateChanged = false;

    for (const channelName of CHANNELS) {
        try {
            console.log(`\nChecking Telegram channel: ${channelName}...`);
            const url = `https://t.me/s/${channelName}`;
            const { data } = await axios.get(url);
            const $ = cheerio.load(data);

            const messages = $('.tgme_widget_message');

            for (let i = 0; i < messages.length; i++) {
                const el = messages[i];
                const postId = $(el).attr('data-post');
                const textContent = $(el).find('.tgme_widget_message_text').text().trim();

                let imageUrl = '';
                const photoEl = $(el).find('.tgme_widget_message_photo');
                if (photoEl.length > 0) {
                    const styleAttr = photoEl.attr('style'); 
                    if (styleAttr) {
                        const match = styleAttr.match(/url\(['"]?(.*?)['"]?\)/);
                        if (match && match[1]) {
                            imageUrl = match[1];
                        }
                    }
                }

                if (!imageUrl) {
                    const imgTag = $(el).find('.tgme_widget_message_inline_photo img, .tgme_widget_message_photo img');
                    if (imgTag.length > 0) {
                        imageUrl = imgTag.attr('src');
                    }
                }

                if (postId && !sentPosts.has(postId)) {
                    console.log(`New post found in ${channelName} (${postId}). Processing media & publishing...`);
                    
                    let mediaUrl = '';
                    if (imageUrl) {
                        mediaUrl = await uploadToBlossom(imageUrl);
                    }

                    let finalMessage = textContent;
                    if (mediaUrl) {
                        finalMessage = finalMessage ? `${finalMessage}\n\n${mediaUrl}` : mediaUrl;
                    }

                    if (finalMessage) {
                        await publishToNostr(finalMessage);
                    }
                    
                    sentPosts.add(postId);
                    stateChanged = true;
                }
            }
        } catch (error) {
            console.error(`Error fetching Telegram channel (${channelName}):`, error.message);
        }
    }

    // Save state once after all channels and messages have been processed
    if (stateChanged) {
        saveState();
    }
}

async function publishToNostr(text) {
    try {
        if (!PRIVATE_KEY_HEX || PRIVATE_KEY_HEX.startsWith('nsec')) {
            console.error("Error: Please provide your private key in HEX format inside config.json.");
            return;
        }
        let privKeyBytes = Uint8Array.from(Buffer.from(PRIVATE_KEY_HEX, 'hex'));

        const eventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: text,
        };

        const signedEvent = finalizeEvent(eventTemplate, privKeyBytes);

        for (const url of RELAY_URLS) {
            let relay;
            try {
                relay = await Relay.connect(url);
                await relay.publish(signedEvent);
                console.log(`Successfully published to: ${relay.url}`);
            } catch (err) {
                console.error(`Failed to publish to ${url}:`, err.message);
            } finally {
                if (relay) {
                    relay.close();
                }
            }
        }
    } catch (err) {
        console.error('Failed to prepare Nostr event:', err);
    }
}

// Run immediately on start, then every 5 minutes
checkTelegramAndPost();
setInterval(checkTelegramAndPost, 5 * 60 * 1000);