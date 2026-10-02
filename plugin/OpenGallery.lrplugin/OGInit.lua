-- Runs when Lightroom loads the plugin. Writes one line to ~/Documents/LrClassicLogs/Kreate.log so an install can be verified without the UI.
local LrLogger = import 'LrLogger'
local logger = LrLogger('Kreate')
logger:enable('logfile')
local ok, err = pcall(function()
  logger:info('Kreate plugin loaded', 'version 0.1.0 (m4)', 'Lightroom ' .. tostring(import('LrApplication').versionString()))
end)
if not ok then logger:error('init failed', tostring(err)) end
