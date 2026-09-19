-- Usage: lua api_test.lua <baseUrl> <token> <jpegPath> <pluginDir> <testsDir>
local baseUrl, token, jpegPath, pluginDir, testsDir = ...
package.path = pluginDir .. '/?.lua;' .. testsDir .. '/?.lua;' .. package.path
local json = require 'json'
local OGApi = require 'OGApi'
local http = require 'curl_http'

-- json round trips
assert(json.encode({ a = { 1, 2, 'x' }, b = json.null, c = true, d = 'q"\n' }) == '{"a":[1,2,"x"],"b":null,"c":true,"d":"q\\"\\n"}')
local d = json.decode('{"n":-1.5e2,"s":"\\u00e9\\ud83d\\ude00","arr":[],"o":{},"z":null}')
assert(d.n == -150 and d.s == 'é😀' and #d.arr == 0 and d.z == json.null)

local api = OGApi.new{ baseUrl = baseUrl, token = token, http = http }
local me = assert(api:me()); assert(me.scope == 'read+write', 'scope')
local projects = assert(api:projects())
local project
for _, p in ipairs(projects) do if p.title == 'Wedding' then project = p end end
assert(project, 'Wedding project'); assert(project.folders.finals == 'finals')

local ids = assert(api:resolve(project.id, { 'raw/a.dng', 'raw/b.dng', 'raw/nope.dng' }))
assert(ids['raw/a.dng'] and ids['raw/b.dng'] and ids['raw/nope.dng'] == false, 'resolve')

local r1 = assert(api:uploadFinal(project.id, { filePath = jpegPath, name = 'DSC_0001.jpg', sourcePhotoId = ids['raw/a.dng'], uploadId = 'lua-1' }))
assert(r1.relPath == 'finals/DSC_0001.jpg' and r1.photoId, 'upload 1')
local r2 = assert(api:uploadFinal(project.id, { filePath = jpegPath, name = 'DSC_0001.jpg', sourcePhotoId = ids['raw/b.dng'], uploadId = 'lua-2' }))
assert(r2.relPath == 'finals/DSC_0001 (2).jpg', 'collision naming: ' .. tostring(r2.relPath))
local r3 = assert(api:uploadFinal(project.id, { filePath = jpegPath, name = 'DSC_0001.jpg', sourcePhotoId = ids['raw/a.dng'], uploadId = 'lua-1' }))
assert(r3.idempotent == true and r3.photoId == r1.photoId, 'idempotent')

local picks = assert(api:picks(project.id))
assert(picks.round == 1 and #picks.picks == 1 and picks.picks[1].relPath == 'raw/a.dng', 'picks after finish')

local comments = assert(api:comments(project.id))
assert(#comments >= 1 and comments[1].hint == 'top-left', 'comment hint: ' .. tostring(comments[1] and comments[1].hint))
assert(api:addComment(ids['raw/a.dng'], 'on it'))
assert(#assert(api:comments(project.id)) == #comments + 1, 'reply added')
assert(#assert(api:comments(project.id, comments[1].createdAt)) == 1, 'since filter')

local prog = assert(api:progress(project.id, { { photoId = ids['raw/a.dng'], state = 'editing' }, { photoId = ids['raw/b.dng'], state = 'editing' } }))
assert(prog.updated == 1 and prog.skipped == 1, 'progress')

assert(api:deleteFinal(r2.photoId))
local _, err = api:deleteFinal(r2.photoId); assert(err and err:match('404'), 'second delete 404')
local _, err2 = OGApi.new{ baseUrl = baseUrl, token = 'ogp_bad', http = http }:me(); assert(err2 and err2:match('token rejected'), 'bad token message')
local _, err3 = OGApi.new{ baseUrl = 'http://127.0.0.1:1', token = token, http = http }:me(); assert(err3 and err3:match('No response'), 'no response message')
print('OK')
