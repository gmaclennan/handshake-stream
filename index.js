var stream = require('stream')
var duplexify = require('duplexify')
var decoder = require('./decoder')

module.exports = HandshakeStream

function HandshakeStream (protocol, payload, shake) {
  var res = duplexify.obj()

  // valid states: start, accepted, pre-shake, pre-shake-accepted, ready
  var state = 'start'

  var decode = decoder()
  var accum = Buffer.alloc(0)

  var w = new stream.Writable()
  w._write = function (chunk, enc, next) {
    if (state === 'error') return
    if (chunk.length === 0) return next()

    if (state === 'ready') {
      // once the handshake is accepted, start forwarding incoming data to
      // the inner protocol stream
      var ok = protocol.write(chunk)
      if (!ok) protocol.once('drain', next) // respect backpressure from protocol
      else next()
    } else if (state === 'accepted') {
      // we've accepted the stream, but are waiting for the other side to accept
      // as well. they should send a byte with all 1s set
      if (chunk.readUInt8(0) !== 127) {
        state = 'error'
        return next(new Error('unexpected non-ready-signal byte received'))
      }
      res.emit('accepted')
      upgrade(chunk.slice(1))
      next()
    } else if (state === 'pre-shake') {
      if (chunk.readUInt8(0) !== 127) {
        state = 'error'
        return next(new Error('unexpected non-ready-signal byte received'))
      }
      process.nextTick(function () {
        res.emit('accepted')
      })
      state = 'pre-shake-accepted'
      next()
    } else if (state === 'start') {
      // accumulate buffer chunks from the stream until the full handshake
      // object is collected
      var output
      try {
        output = decode(chunk)
      } catch (e) {
        next(e)
      }
      if (!output) return next()

      var req
      try {
        req = JSON.parse(output[0])
      } catch (e) {
        next(e)
      }
      var once = false
      state = 'pre-shake'
      shake(req, function (err) {
        if (once) return
        once = true
        if (err) return next(err)

        // check if the other side's ACCEPT byte was received
        if (state === 'pre-shake-accepted') {
          upgrade(output[1].slice(1))
        } else if (output[1].length >= 1) {
          if (chunk.readUInt8(0) !== 127) {
            state = 'error'
            return next(new Error('unexpected non-ready-signal byte received'))
          }
          res.emit('accepted')
          upgrade(output[1].slice(1))
        } else {
          state = 'accepted'
        }

        // send acceptance signal
        var signalBuf = Buffer.alloc(1).fill(127)
        r.push(signalBuf)
      })
      next()
    } else {
      res.emit('error', new Error('internal error: unknown state ' + state))
    }
  }

  var r = new stream.Readable()
  r._read = function () {
  }

  // write length-prefixed json
  var json = JSON.stringify(payload)
  var lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32LE(json.length, 0)
  r.push(lenBuf)
  r.push(json)

  res.setReadable(r)
  res.setWritable(w)

  function upgrade (accum) {
    state = 'ready'
    // upgrade the stream to the inner protocol
    protocol.on('data', function (data) {
      res.push(data)
    })
    protocol.on('finish', function () {
      res.end()
    })
    res.write(accum)
    protocol.resume()
  }

  return res
}
