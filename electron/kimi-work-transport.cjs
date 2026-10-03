const { EventEmitter } = require('node:events');

// The fixed API reader supplies the URL and headers. Electron handles the system proxy.
function electronTransport(net) {
  return { request(options, callback) {
    const request = net.request({ url: `https://${options.hostname}${options.path}`, method: options.method,
      redirect: 'error', useSessionCookies: false, credentials: 'omit', cache: 'no-store' });
    const bridge = new EventEmitter();
    for (const [name, value] of Object.entries(options.headers)) {
      // Electron computes its own Content-Length and rejects setting it explicitly.
      if (name.toLowerCase() !== 'content-length') request.setHeader(name, value);
    }
    request.on('response', incoming => {
      const response = new EventEmitter();
      response.statusCode = incoming.statusCode;
      response.headers = Object.fromEntries(Object.entries(incoming.headers).map(([key, value]) =>
        [key, Array.isArray(value) ? value[0] : value]));
      response.destroy = () => { request.abort(); bridge.emit('close'); };
      for (const event of ['data', 'end', 'error']) incoming.on(event, value => response.emit(event, value));
      incoming.on('aborted', () => response.emit('error', new Error('network')));
      callback(response);
    });
    request.on('error', () => bridge.emit('error', new Error('network')));
    request.on('close', () => bridge.emit('close'));
    bridge.destroy = () => { request.abort(); bridge.emit('close'); };
    bridge.end = body => request.end(body);
    return bridge;
  } };
}

module.exports = { electronTransport };
