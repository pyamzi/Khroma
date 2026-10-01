-- Small helpers shared by the provider and the menu items. Lightroom imports are done lazily so the file also loads under plain Lua.
local M = {}

function M.trim(s) return (tostring(s or ''):gsub('^%s+', ''):gsub('%s+$', '')) end

-- "2026-06-14T10:20:30.123Z" -> seconds since 2001-01-01 (Lightroom's Cocoa-style time) via LrDate, or nil.
function M.isoToLrTime(iso)
  if type(iso) ~= 'string' then return nil end
  local y, mo, d, h, mi, s = iso:match('^(%d+)%-(%d+)%-(%d+)T(%d+):(%d+):(%d+)')
  if not y then return nil end
  local LrDate = import 'LrDate'
  return LrDate.timeFromComponents(tonumber(y), tonumber(mo), tonumber(d), tonumber(h), tonumber(mi), tonumber(s), 'UTC')
end

-- Join the NAS mount path, the project folder (forward slashes) and a project-relative path into a catalog path.
function M.catalogPath(mountPath, folderPath, rel)
  local LrPathUtils = import 'LrPathUtils'
  local p = M.trim(mountPath)
  for seg in (folderPath .. '/' .. rel):gmatch('[^/]+') do p = LrPathUtils.child(p, seg) end
  return p
end

-- A catalog file path under the mount -> project-relative path ("raw/DSC_0412.NEF") for the project whose folderPath it lies in, or nil.
function M.relativeToProject(mountPath, folderPath, filePath)
  local LrPathUtils = import 'LrPathUtils'
  local root = M.trim(mountPath)
  for seg in folderPath:gmatch('[^/]+') do root = LrPathUtils.child(root, seg) end
  local norm = function(x) return (x:gsub('\\', '/'):gsub('/+$', '')) end
  local r, f = norm(root), norm(filePath)
  if f:sub(1, #r + 1) ~= r .. '/' then return nil end
  return f:sub(#r + 2)
end

-- names: array of file names. Returns { [name] = count } for names that occur more than once (case-sensitive, like the server's paths).
function M.duplicateLeaves(names)
  local counts, dups = {}, {}
  for _, n in ipairs(names) do counts[n] = (counts[n] or 0) + 1 end
  for n, c in pairs(counts) do if c > 1 then dups[n] = c end end
  return dups
end

function M.uploadId(photo, renderedPath)
  local uuid = photo:getRawMetadata('uuid') or tostring(photo)
  local LrFileUtils = import 'LrFileUtils'
  local size = LrFileUtils.fileAttributes(renderedPath).fileSize or 0
  return uuid .. ':' .. tostring(size) .. ':' .. tostring(os.time())
end

return M
