function parseConcurrencyLevels(value, defaults) {
  if (value === undefined || value === null || value.trim() === "") return [...defaults];
  const parsed = value.split(",").map((part) => {
    const level = Number(part.trim());
    if (!Number.isInteger(level) || level < 1 || level > 1000) {
      throw new Error("concurrency levels must be integers from 1 to 1000");
    }
    return level;
  });
  return [...new Set(parsed)];
}

function createLaunchBarrier(participantCount) {
  if (!Number.isInteger(participantCount) || participantCount < 1) {
    throw new Error("launch barrier requires at least one participant");
  }
  let arrived = 0;
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  return {
    wait() {
      arrived += 1;
      if (arrived > participantCount) {
        throw new Error("launch barrier received too many participants");
      }
      if (arrived === participantCount) release();
      return released;
    }
  };
}

module.exports = { createLaunchBarrier, parseConcurrencyLevels };
