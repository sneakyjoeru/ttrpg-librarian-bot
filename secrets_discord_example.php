<?php
// secrets_discord.php

/**
 * Discord Application Credentials
 * Ensure this file is kept in the same directory as your main script
 * or update the require_once path accordingly.
 */

$app_id        = ''; // Your Discord Application ID
$public_key    = '';
$token         = '';   // This is the Bot Token (keep this very secure)
$client_id     = '';
$client_secret = '';
$deepseek_api_key   = ''; // DeepSeek API key (cloud model)
$openrouter_api_key = ''; // optional: OpenRouter key, cloud fallback ahead of DeepSeek (GPT-6 Luna)

/**
 * Security Note: 
 * Ensure your Apache configuration prevents web access to .php files 
 * or place this file outside the public_html/var/www/html directory 
 * for maximum security.
 */
?>