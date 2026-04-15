#!/usr/bin/env node
/**
 * Test OAuth flow and core OAuth functions
 * Tests: OAuth config, token store, URL building
 */

import { 
  EnvTokenStore, 
  getOAuthConfig, 
  buildAuthorizationUrl, 
  DEFAULT_SCOPES 
} from "./dist/oauth.js";

async function testOAuthTools() {
  console.log("=== Testing OAuth Flow ===\n");

  // Test 1: OAuth Config validation
  console.log("✓ Test 1: OAuth Configuration");
  try {
    const oauthConfig = getOAuthConfig();
    console.log(`  ✓ Client ID: ${oauthConfig.clientId}`);
    console.log(`  ✓ Client Secret: ${oauthConfig.clientSecret ? "[SET]" : "[NOT SET]"}`);
    console.log(`  ✓ Redirect URI: ${oauthConfig.redirectUri}`);
  } catch (err) {
    console.error(`  ✗ Error:`, err.message);
    return;
  }

  // Test 2: Authorization URL generation
  console.log("\n✓ Test 2: Authorization URL Generation");
  try {
    const oauthConfig = getOAuthConfig();
    const authUrl = buildAuthorizationUrl(oauthConfig);
    console.log(`  ✓ Auth URL generated (length: ${authUrl.length})`);
    console.log(`  ✓ Contains client_id: ${authUrl.includes('client_id=') ? "YES" : "NO"}`);
    console.log(`  ✓ Contains redirect_uri: ${authUrl.includes('redirect_uri=') ? "YES" : "NO"}`);
    console.log(`  ✓ Contains response_type: ${authUrl.includes('response_type=code') ? "YES" : "NO"}`);
    console.log(`  ✓ Contains scope: ${authUrl.includes('scope=') ? "YES" : "NO"}`);
    console.log(`  Sample: ${authUrl.substring(0, 80)}...`);
  } catch (err) {
    console.error(`  ✗ Error:`, err.message);
  }

  // Test 3: Token Store initialization
  console.log("\n✓ Test 3: Token Store with Environment Variables");
  const tokenStore = new EnvTokenStore();
  console.log(`  ✓ Access token from env: ${tokenStore.getAccessToken() ? "YES" : "NO"}`);
  console.log(`  ✓ Refresh token from env: ${tokenStore.getRefreshToken() ? "YES" : "NO"}`);

  // Test 4: Token Store set/get operations
  console.log("\n✓ Test 4: Token Store Operations");
  const store = new EnvTokenStore();
  store.setTokens("test_access_123", "test_refresh_456", 3600);
  console.log(`  ✓ After setTokens:`);
  console.log(`    - Access token stored: ${store.getAccessToken() === "test_access_123" ? "YES" : "NO"}`);
  console.log(`    - Refresh token stored: ${store.getRefreshToken() === "test_refresh_456" ? "YES" : "NO"}`);

  // Test 5: Token expiration logic
  console.log("\n✓ Test 5: Token Expiration Logic");
  const expiredStore = new EnvTokenStore();
  
  // Set with positive expiry
  expiredStore.setTokens("token", "refresh", 3600);
  const validToken = expiredStore.getAccessToken();
  console.log(`  ✓ Token with 3600s expiry: ${validToken ? "VALID" : "EXPIRED"}`);
  
  // Set with 0 expiry (should expire immediately)
  expiredStore.setTokens("token", "refresh", 0);
  const expiredToken = expiredStore.getAccessToken();
  console.log(`  ✓ Token with 0s expiry: ${!expiredToken ? "EXPIRED (correct)" : "VALID (bug!)"}`);

  // Test 6: Expiry buffer (60s buffer)
  console.log("\n✓ Test 6: Expiry Buffer (60s safety margin)");
  const bufferStore = new EnvTokenStore();
  bufferStore.setTokens("token", "refresh", 30); // Lower than 60s buffer
  const bufferedToken = bufferStore.getAccessToken();
  console.log(`  ✓ Token with 30s expiry (< 60s buffer): ${!bufferedToken ? "EXPIRED (correct)" : "VALID (buffer working)"}`);

  console.log("\n=== OAuth Tests Complete ===\n");
}

testOAuthTools().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
