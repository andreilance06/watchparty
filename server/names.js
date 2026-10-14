function sanitizeDisplayName(value, fallback = "Guest") {
  const name = String(value || "").replace(/\s+/g, " ").trim().slice(0, 24);
  return name || fallback;
}

function displayNameKey(value) {
  return sanitizeDisplayName(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

function createNameRegistry(clients) {
  function isDisplayNameTaken(name, exceptClientId = null) {
    const key = displayNameKey(name);
    for (const [clientId, client] of clients) {
      if (clientId !== exceptClientId && displayNameKey(client.name) === key) return true;
    }
    return false;
  }
  
  function availableGuestName(clientId) {
    const token = String(clientId || "user").replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase() || "USER";
    const base = `Guest-${token}`;
    if (!isDisplayNameTaken(base)) return base;
    let suffix = 2;
    while (isDisplayNameTaken(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
  }

  return { isDisplayNameTaken, availableGuestName };
}

module.exports = { sanitizeDisplayName, displayNameKey, createNameRegistry };
