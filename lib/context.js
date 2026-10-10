// Runtime state shared by the modules, filled once by agent.js at startup.
// Modules read it at call time, so their pure functions can be imported by the
// tests without any config or database.
module.exports = {
  root: null,
  cfg: null,
  db: null,
  lang: 'en',
};
