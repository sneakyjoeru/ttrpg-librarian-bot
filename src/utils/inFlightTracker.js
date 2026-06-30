// Central in-flight tracking to avoid circular dependencies between
// messageCreate.js and the platform handlers.
// Ported from robot-joe (identical).

// Prevents catch-up scanner from re-dispatching a message currently being processed.
const inFlightMessages = new Set();

// Prevents startup cleanup from treating a brand-new working placeholder as abandoned.
const inFlightPlaceholders = new Set();

module.exports = {
    inFlightMessages,
    inFlightPlaceholders
};