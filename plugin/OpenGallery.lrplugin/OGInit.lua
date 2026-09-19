-- Runs when Lightroom loads the plugin. Writes one line to ~/Documents/LrClassicLogs/OpenGallery.log so an install can be verified without the UI.
local LrLogger = import 'LrLogger'
local logger = LrLogger('OpenGallery')
logger:enable('logfile')
local ok, err = pcall(function()
  logger:info('OpenGallery plugin loaded', 'version 0.1.0 (m4)', 'Lightroom ' .. tostring(import('LrApplication').versionString()))
end)
if not ok then logger:error('init failed', tostring(err)) end
