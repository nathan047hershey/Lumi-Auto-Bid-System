// Test if the regex is correct
const re = /your\s+code|code\s+is|code:|otp|one[-\s]?time|verification|passcode|pin\s+code/i;
const test = 'Your code is 482915';
console.log('match:', re.test(test));
console.log('source:', re.source);
