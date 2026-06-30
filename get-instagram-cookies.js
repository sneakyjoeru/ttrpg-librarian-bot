#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

async function run() {
    let puppeteer;
    try {
        puppeteer = require('puppeteer');
    } catch (err) {
        console.error('\nERROR: "puppeteer" package is not installed.');
        console.error('Please run the following command in your terminal first:');
        console.error('  npm install puppeteer\n');
        process.exit(1);
    }

    console.log('Launching browser window... Please wait.');
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ['--start-maximized']
    });

    const page = await browser.newPage();
    console.log('Navigating to Instagram Login...');
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2' });

    console.log('\n================================================================');
    console.log(' ACTION REQUIRED: Please log in to Instagram in the browser window.');
    console.log(' (Solve any CAPTCHAs, 2FA codes, or security checks if prompted).');
    console.log(' The script will automatically detect once you are logged in.');
    console.log('================================================================\n');

    // Wait for the login by checking for the sessionid cookie
    let loggedIn = false;
    let checkInterval;

    const checkLogin = async () => {
        try {
            const cookies = await page.cookies();
            const sessionCookie = cookies.find(c => c.name === 'sessionid');
            if (sessionCookie) {
                loggedIn = true;
                clearInterval(checkInterval);

                console.log('Login detected! Generating cookies.txt...');
                
                // Format cookies to Netscape format
                let netscapeString = '# Netscape HTTP Cookie File\n';
                netscapeString += '# http://curl.haxx.se/rfc/cookie_spec.html\n';
                netscapeString += '# This is a generated file! Do not edit.\n\n';

                for (const cookie of cookies) {
                    const domain = cookie.domain || '';
                    const isSubdomain = domain.startsWith('.') ? 'TRUE' : 'FALSE';
                    const cookiePath = cookie.path || '/';
                    const secure = cookie.secure ? 'TRUE' : 'FALSE';
                    const expires = cookie.expires ? Math.round(cookie.expires) : 0;
                    const name = cookie.name || '';
                    const value = cookie.value || '';

                    netscapeString += `${domain}\t${isSubdomain}\t${cookiePath}\t${secure}\t${expires}\t${name}\t${value}\n`;
                }

                const outputPath = path.join(__dirname, 'cookies.txt');
                fs.writeFileSync(outputPath, netscapeString, 'utf8');

                console.log(`\nSUCCESS: cookies.txt generated successfully at:`);
                console.log(`  ${outputPath}`);
                console.log('\nYou can now run the rebuild-run.sh script to update the bot container.\n');

                await browser.close();
                process.exit(0);
            }
        } catch (e) {
            console.error('Error checking cookies:', e.message);
        }
    };

    checkInterval = setInterval(checkLogin, 2000);

    // Also close script if browser is closed manually
    browser.on('disconnected', () => {
        if (!loggedIn) {
            console.log('Browser was closed before login completed. Exiting.');
            process.exit(0);
        }
    });
}

run().catch(err => {
    console.error('Fatal error running helper script:', err.message);
    process.exit(1);
});