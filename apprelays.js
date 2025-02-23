﻿/**
* @description MeshCentral MSTSC & SSH relay
* @author Ylian Saint-Hilaire & Bryan Roe
* @copyright Intel Corporation 2018-2021
* @license Apache-2.0
* @version v0.0.1
*/

/*jslint node: true */
/*jshint node: true */
/*jshint strict:false */
/*jshint -W097 */
/*jshint esversion: 6 */
"use strict";

// Construct a MSTSC Relay object, called upon connection
// This is a bit of a hack as we are going to run the RDP connection thru a loopback connection.
// If the "node-rdpjs-2" module supported passing a socket, we would do something different.
module.exports.CreateMstscRelay = function (parent, db, ws, req, args, domain) {
    const Net = require('net');
    const WebSocket = require('ws');

    var obj = {};
    obj.ws = ws;
    obj.tcpServerPort = 0;
    obj.relayActive = false;
    var rdpClient = null;

    parent.parent.debug('relay', 'RDP: Request for RDP relay (' + req.clientIp + ')');

    // Disconnect
    obj.close = function (arg) {
        if (obj.ws == null) return;

        // Collect how many raw bytes where received and sent.
        // We sum both the websocket and TCP client in this case.
        //var inTraffc = obj.ws._socket.bytesRead, outTraffc = obj.ws._socket.bytesWritten;
        //if (obj.wsClient != null) { inTraffc += obj.wsClient._socket.bytesRead; outTraffc += obj.wsClient._socket.bytesWritten; }
        //console.log('WinRDP - in', inTraffc, 'out', outTraffc);

        if (obj.wsClient) { obj.wsClient.close(); delete obj.wsClient; }
        if (obj.tcpServer) { obj.tcpServer.close(); delete obj.tcpServer; }
        if (rdpClient) { rdpClient.close(); rdpClient = null; }
        if ((arg == 1) || (arg == null)) { try { ws.close(); } catch (e) { console.log(e); } } // Soft close, close the websocket
        if (arg == 2) { try { ws._socket._parent.end(); } catch (e) { console.log(e); } } // Hard close, close the TCP socket
        obj.ws.removeAllListeners();
        obj.relayActive = false;
        delete obj.ws;
    };

    // Start the looppback server
    function startTcpServer() {
        obj.tcpServer = new Net.Server();
        obj.tcpServer.listen(0, '127.0.0.1', function () { obj.tcpServerPort = obj.tcpServer.address().port; startRdp(obj.tcpServerPort); });
        obj.tcpServer.on('connection', function (socket) {
            if (obj.relaySocket != null) {
                socket.close();
            } else {
                obj.relaySocket = socket;
                obj.relaySocket.pause();
                obj.relaySocket.on('data', function (chunk) { // Make sure to handle flow control.
                    if (obj.relayActive == true) { obj.relaySocket.pause(); obj.wsClient.send(chunk, function () { obj.relaySocket.resume(); }); }
                });
                obj.relaySocket.on('end', function () { obj.close(); });
                obj.relaySocket.on('error', function (err) { obj.close(); });

                // Decode the authentication cookie
                var cookie = parent.parent.decodeCookie(obj.infos.ip, parent.parent.loginCookieEncryptionKey);
                if (cookie == null) return;

                // Setup the correct URL with domain and use TLS only if needed.
                var options = { rejectUnauthorized: false };
                if (domain.dns != null) { options.servername = domain.dns; }
                var protocol = (args.tlsoffload) ? 'ws' : 'wss';
                var domainadd = '';
                if ((domain.dns == null) && (domain.id != '')) { domainadd = domain.id + '/' }
                var url = protocol + '://127.0.0.1:' + args.port + '/' + domainadd + ((cookie.lc == 1) ? 'local' : 'mesh') + 'relay.ashx?noping=1&p=10&auth=' + obj.infos.ip;  // Protocol 10 is Web-RDP
                parent.parent.debug('relay', 'RDP: Connection websocket to ' + url);
                obj.wsClient = new WebSocket(url, options);
                obj.wsClient.on('open', function () { parent.parent.debug('relay', 'RDP: Relay websocket open'); });
                obj.wsClient.on('message', function (data) { // Make sure to handle flow control.
                    if ((obj.relayActive == false) && (data == 'c')) {
                        obj.relayActive = true; obj.relaySocket.resume();
                    } else {
                        obj.wsClient._socket.pause();
                        obj.relaySocket.write(data, function () { obj.wsClient._socket.resume(); });
                    }
                });
                obj.wsClient.on('close', function () { parent.parent.debug('relay', 'RDP: Relay websocket closed'); obj.close(); });
                obj.wsClient.on('error', function (err) { parent.parent.debug('relay', 'RDP: Relay websocket error: ' + err); obj.close(); });
                obj.tcpServer.close();
                obj.tcpServer = null;
            }
        });
    }

    // Start the RDP client
    function startRdp(port) {
        parent.parent.debug('relay', 'RDP: Starting RDP client on loopback port ' + port);
        try {
            rdpClient = require('node-rdpjs-2').createClient({
                logLevel: 'ERROR',
                domain: obj.infos.domain,
                userName: obj.infos.username,
                password: obj.infos.password,
                enablePerf: true,
                autoLogin: true,
                screen: obj.infos.screen,
                locale: obj.infos.locale
            }).on('connect', function () {
                send(['rdp-connect']);
            }).on('bitmap', function (bitmap) {
                try { ws.send(bitmap.data); } catch (ex) { } // Send the bitmap data as binary
                delete bitmap.data;
                send(['rdp-bitmap', bitmap]); // Send the bitmap metadata seperately, without bitmap data.
            }).on('close', function () {
                send(['rdp-close']);
            }).on('error', function (err) {
                send(['rdp-error', err]);
            }).connect('127.0.0.1', obj.tcpServerPort);
        } catch (ex) {
            console.log('startRdpException', ex);
            obj.close();
        }
    }

    // When data is received from the web socket
    // RDP default port is 3389
    ws.on('message', function (msg) {
        try {
            msg = JSON.parse(msg);
            switch (msg[0]) {
                case 'infos': { obj.infos = msg[1]; startTcpServer(); break; }
                case 'mouse': { if (rdpClient) { rdpClient.sendPointerEvent(msg[1], msg[2], msg[3], msg[4]); } break; }
                case 'wheel': { if (rdpClient) { rdpClient.sendWheelEvent(msg[1], msg[2], msg[3], msg[4]); } break; }
                case 'scancode': { if (rdpClient) { rdpClient.sendKeyEventScancode(msg[1], msg[2]); } break; }
                case 'unicode': { if (rdpClient) { rdpClient.sendKeyEventUnicode(msg[1], msg[2]); } break; }
                case 'disconnect': { obj.close(); break; }
            }
        } catch (ex) {
            console.log('RdpMessageException', msg, ex);
            obj.close();
        }
    });

    // If error, do nothing
    ws.on('error', function (err) { parent.parent.debug('relay', 'RDP: Browser websocket error: ' + err); obj.close(); });

    // If the web socket is closed
    ws.on('close', function (req) { parent.parent.debug('relay', 'RDP: Browser websocket closed'); obj.close(); });

    // Send an object with flow control
    function send(obj) {
        try { rdpClient.bufferLayer.socket.pause(); } catch (ex) { }
        try { ws.send(JSON.stringify(obj), function () { try { rdpClient.bufferLayer.socket.resume(); } catch (ex) { } }); } catch (ex) { }
    }

    // We are all set, start receiving data
    ws._socket.resume();

    return obj;
};



// Construct a SSH Relay object, called upon connection
module.exports.CreateSshRelay = function (parent, db, ws, req, args, domain) {
    const Net = require('net');
    const WebSocket = require('ws');

    // SerialTunnel object is used to embed SSH within another connection.
    function SerialTunnel(options) {
        var obj = new require('stream').Duplex(options);
        obj.forwardwrite = null;
        obj.updateBuffer = function (chunk) { this.push(chunk); };
        obj._write = function (chunk, encoding, callback) { if (obj.forwardwrite != null) { obj.forwardwrite(chunk); } if (callback) callback(); }; // Pass data written to forward
        obj._read = function (size) { }; // Push nothing, anything to read should be pushed from updateBuffer()
        obj.destroy = function () { delete obj.forwardwrite; }
        return obj;
    }

    const obj = {};
    obj.ws = ws;
    obj.relayActive = false;

    parent.parent.debug('relay', 'SSH: Request for SSH relay (' + req.clientIp + ')');

    // Disconnect
    obj.close = function (arg) {
        if (obj.ws == null) return;

        // Collect how many raw bytes where received and sent.
        // We sum both the websocket and TCP client in this case.
        //var inTraffc = obj.ws._socket.bytesRead, outTraffc = obj.ws._socket.bytesWritten;
        //if (obj.wsClient != null) { inTraffc += obj.wsClient._socket.bytesRead; outTraffc += obj.wsClient._socket.bytesWritten; }
        //console.log('WinSSH - in', inTraffc, 'out', outTraffc);

        if (obj.sshShell) {
            obj.sshShell.destroy();
            obj.sshShell.removeAllListeners('data');
            obj.sshShell.removeAllListeners('close');
            try { obj.sshShell.end(); } catch (ex) { console.log(ex); }
            delete obj.sshShell;
        }
        if (obj.sshClient) {
            obj.sshClient.destroy();
            obj.sshClient.removeAllListeners('ready');
            try { obj.sshClient.end(); } catch (ex) { console.log(ex); }
            delete obj.sshClient;
        }
        if (obj.wsClient) {
            obj.wsClient.removeAllListeners('open');
            obj.wsClient.removeAllListeners('message');
            obj.wsClient.removeAllListeners('close');
            try { obj.wsClient.close(); } catch (ex) { console.log(ex); }
            delete obj.wsClient;
        }

        if ((arg == 1) || (arg == null)) { try { ws.close(); } catch (ex) { console.log(ex); } } // Soft close, close the websocket
        if (arg == 2) { try { ws._socket._parent.end(); } catch (ex) { console.log(ex); } } // Hard close, close the TCP socket
        obj.ws.removeAllListeners();

        obj.relayActive = false;
        delete obj.termSize;
        delete obj.cookie;
        delete obj.ws;
    };

    // Decode the authentication cookie
    obj.cookie = parent.parent.decodeCookie(req.query.auth, parent.parent.loginCookieEncryptionKey);
    if (obj.cookie == null) { obj.ws.send(JSON.stringify({ action: 'sessionerror' })); obj.close(); return; }

    // Start the looppback server
    function startRelayConnection() {
        try {
            // Setup the correct URL with domain and use TLS only if needed.
            var options = { rejectUnauthorized: false };
            if (domain.dns != null) { options.servername = domain.dns; }
            var protocol = 'wss';
            if (args.tlsoffload) { protocol = 'ws'; }
            var domainadd = '';
            if ((domain.dns == null) && (domain.id != '')) { domainadd = domain.id + '/' }
            var url = protocol + '://127.0.0.1:' + args.port + '/' + domainadd + ((obj.cookie.lc == 1) ? 'local' : 'mesh') + 'relay.ashx?noping=1&p=11&auth=' + req.query.auth; // Protocol 11 is Web-SSH
            parent.parent.debug('relay', 'SSH: Connection websocket to ' + url);
            obj.wsClient = new WebSocket(url, options);
            obj.wsClient.on('open', function () { parent.parent.debug('relay', 'SSH: Relay websocket open'); });
            obj.wsClient.on('message', function (data) { // Make sure to handle flow control.
                if ((obj.relayActive == false) && (data == 'c')) {
                    obj.relayActive = true;

                    // Create a serial tunnel && SSH module
                    obj.ser = new SerialTunnel();
                    const Client = require('ssh2').Client;
                    obj.sshClient = new Client();
                    obj.sshClient.on('ready', function () { // Authentication was successful.
                        obj.sshClient.shell(function (err, stream) { // Start a remote shell
                            if (err) { obj.close(); return; }
                            obj.sshShell = stream;
                            obj.sshShell.setWindow(obj.termSize.rows, obj.termSize.cols, obj.termSize.height, obj.termSize.width);
                            obj.sshShell.on('close', function () { obj.close(); });
                            obj.sshShell.on('data', function (data) { obj.ws.send('~' + data.toString()); });
                        });
                        obj.ws.send(JSON.stringify({ action: 'connected' }));
                    });
                    obj.sshClient.on('error', function (err) {
                        if (err.level == 'client-authentication') { obj.ws.send(JSON.stringify({ action: 'autherror' })); }
                        obj.close();
                    });

                    // Setup the serial tunnel, SSH ---> Relay WS
                    obj.ser.forwardwrite = function (data) { if ((data.length > 0) && (obj.wsClient != null)) { try { obj.wsClient.send(data); } catch (ex) { } } };

                    // Connect the SSH module to the serial tunnel
                    var connectionOptions = { sock: obj.ser }
                    if (typeof obj.username == 'string') { connectionOptions.username = obj.username; delete obj.username; }
                    if (typeof obj.password == 'string') { connectionOptions.password = obj.password; delete obj.password; }
                    obj.sshClient.connect(connectionOptions);

                    // We are all set, start receiving data
                    ws._socket.resume();
                } else {
                    // Relay WS --> SSH
                    if ((data.length > 0) && (obj.ser != null)) { try { obj.ser.updateBuffer(data); } catch (ex) { console.log(ex); } }
                }
            });
            obj.wsClient.on('close', function () { parent.parent.debug('relay', 'SSH: Relay websocket closed'); obj.close(); });
            obj.wsClient.on('error', function (err) { parent.parent.debug('relay', 'SSH: Relay websocket error: ' + err); obj.close(); });
        } catch (ex) {
            console.log(ex);
        }
    }

    // When data is received from the web socket
    // SSH default port is 22
    ws.on('message', function (msg) {
        try {
            if (typeof msg != 'string') return;
            if (msg[0] == '{') {
                // Control data
                msg = JSON.parse(msg);
                if (typeof msg.action != 'string') return;
                switch (msg.action) {
                    case 'connect': {
                        // Verify inputs
                        if ((typeof msg.username != 'string') || (typeof msg.password != 'string')) break;
                        if ((typeof msg.rows != 'number') || (typeof msg.cols != 'number') || (typeof msg.height != 'number') || (typeof msg.width != 'number')) break;

                        obj.termSize = msg;
                        obj.username = msg.username;
                        obj.password = msg.password;
                        startRelayConnection();
                        break;
                    }
                    case 'resize': {
                        // Verify inputs
                        if ((typeof msg.rows != 'number') || (typeof msg.cols != 'number') || (typeof msg.height != 'number') || (typeof msg.width != 'number')) break;

                        obj.termSize = msg;
                        if (obj.sshShell != null) { obj.sshShell.setWindow(obj.termSize.rows, obj.termSize.cols, obj.termSize.height, obj.termSize.width); }
                        break;
                    }
                }
            } else if (msg[0] == '~') {
                // Terminal data
                if (obj.sshShell != null) { obj.sshShell.write(msg.substring(1)); }
            }
        } catch (ex) { obj.close(); }
    });

    // If error, do nothing
    ws.on('error', function (err) { parent.parent.debug('relay', 'SSH: Browser websocket error: ' + err); obj.close(); });

    // If the web socket is closed
    ws.on('close', function (req) { parent.parent.debug('relay', 'SSH: Browser websocket closed'); obj.close(); });
    
    return obj;
};


// Construct a SSH Terminal Relay object, called upon connection
module.exports.CreateSshTerminalRelay = function (parent, db, ws, req, domain, user, cookie, args) {
    const Net = require('net');
    const WebSocket = require('ws');

    // SerialTunnel object is used to embed SSH within another connection.
    function SerialTunnel(options) {
        var obj = new require('stream').Duplex(options);
        obj.forwardwrite = null;
        obj.updateBuffer = function (chunk) { this.push(chunk); };
        obj._write = function (chunk, encoding, callback) { if (obj.forwardwrite != null) { obj.forwardwrite(chunk); } if (callback) callback(); }; // Pass data written to forward
        obj._read = function (size) { }; // Push nothing, anything to read should be pushed from updateBuffer()
        obj.destroy = function () { delete obj.forwardwrite; }
        return obj;
    }

    const obj = {};
    obj.ws = ws;
    obj.relayActive = false;

    parent.parent.debug('relay', 'SSH: Request for SSH terminal relay (' + req.clientIp + ')');

    // Disconnect
    obj.close = function (arg) {
        if (obj.ws == null) return;

        // Collect how many raw bytes where received and sent.
        // We sum both the websocket and TCP client in this case.
        //var inTraffc = obj.ws._socket.bytesRead, outTraffc = obj.ws._socket.bytesWritten;
        //if (obj.wsClient != null) { inTraffc += obj.wsClient._socket.bytesRead; outTraffc += obj.wsClient._socket.bytesWritten; }
        //console.log('WinSSH - in', inTraffc, 'out', outTraffc);

        if (obj.sshShell) {
            obj.sshShell.destroy();
            obj.sshShell.removeAllListeners('data');
            obj.sshShell.removeAllListeners('close');
            try { obj.sshShell.end(); } catch (ex) { console.log(ex); }
            delete obj.sshShell;
        }
        if (obj.sshClient) {
            obj.sshClient.destroy();
            obj.sshClient.removeAllListeners('ready');
            try { obj.sshClient.end(); } catch (ex) { console.log(ex); }
            delete obj.sshClient;
        }
        if (obj.wsClient) {
            obj.wsClient.removeAllListeners('open');
            obj.wsClient.removeAllListeners('message');
            obj.wsClient.removeAllListeners('close');
            try { obj.wsClient.close(); } catch (ex) { console.log(ex); }
            delete obj.wsClient;
        }

        if ((arg == 1) || (arg == null)) { try { ws.close(); } catch (ex) { console.log(ex); } } // Soft close, close the websocket
        if (arg == 2) { try { ws._socket._parent.end(); } catch (ex) { console.log(ex); } } // Hard close, close the TCP socket
        obj.ws.removeAllListeners();

        obj.relayActive = false;
        delete obj.termSize;
        delete obj.cookie;
        delete obj.ws;
    };

    // Save SSH credentials into device
    function saveSshCredentials() {
        parent.parent.db.Get(obj.nodeid, function (err, nodes) {
            if ((err != null) || (nodes == null) || (nodes.length != 1)) return;
            const node = nodes[0];
            const changed = (node.ssh == null);

            // Save the credentials
            node.ssh = { u: obj.username, p: obj.password };
            parent.parent.db.Set(node);

            // Event node change if needed
            if (changed) {
                // Event the node change
                var event = { etype: 'node', action: 'changenode', nodeid: obj.nodeid, domain: domain.id, userid: user._id, username: user.name, node: parent.CloneSafeNode(node), msg: "Changed SSH credentials" };
                if (parent.parent.db.changeStream) { event.noact = 1; } // If DB change stream is active, don't use this event to change the node. Another event will come.
                parent.parent.DispatchEvent(parent.CreateMeshDispatchTargets(node.meshid, [obj.nodeid]), obj, event);
            }
        });
    }

    // Start the looppback server
    function startRelayConnection(authCookie) {
        try {
            // Setup the correct URL with domain and use TLS only if needed.
            var options = { rejectUnauthorized: false };
            if (domain.dns != null) { options.servername = domain.dns; }
            var protocol = 'wss';
            if (args.tlsoffload) { protocol = 'ws'; }
            var domainadd = '';
            if ((domain.dns == null) && (domain.id != '')) { domainadd = domain.id + '/' }
            var url = protocol + '://127.0.0.1:' + args.port + '/' + domainadd + ((obj.mtype == 3) ? 'local' : 'mesh') + 'relay.ashx?noping=1&p=11&auth=' + authCookie // Protocol 11 is Web-SSH
            parent.parent.debug('relay', 'SSH: Connection websocket to ' + url);
            obj.wsClient = new WebSocket(url, options);
            obj.wsClient.on('open', function () { parent.parent.debug('relay', 'SSH: Relay websocket open'); });
            obj.wsClient.on('message', function (data) { // Make sure to handle flow control.
                if ((obj.relayActive == false) && (data == 'c')) {
                    obj.relayActive = true;

                    // Create a serial tunnel && SSH module
                    obj.ser = new SerialTunnel();
                    const Client = require('ssh2').Client;
                    obj.sshClient = new Client();
                    obj.sshClient.on('ready', function () { // Authentication was successful.
                        // If requested, save the credentials
                        if (obj.keep === true) saveSshCredentials();

                        obj.sshClient.shell(function (err, stream) { // Start a remote shell
                            if (err) { obj.close(); return; }
                            obj.sshShell = stream;
                            obj.sshShell.setWindow(obj.termSize.rows, obj.termSize.cols, obj.termSize.height, obj.termSize.width);
                            obj.sshShell.on('close', function () { obj.close(); });
                            obj.sshShell.on('data', function (data) { obj.ws.send('~' + data.toString()); });
                        });

                        obj.connected = true;
                        obj.ws.send('c');
                    });
                    obj.sshClient.on('error', function (err) {
                        if (err.level == 'client-authentication') { try { obj.ws.send(JSON.stringify({ action: 'autherror' })); } catch (ex) { } }
                        if (err.level == 'client-timeout') { try { obj.ws.send(JSON.stringify({ action: 'sessiontimeout' })); } catch (ex) { } }
                        obj.close();
                    });

                    // Setup the serial tunnel, SSH ---> Relay WS
                    obj.ser.forwardwrite = function (data) { if ((data.length > 0) && (obj.wsClient != null)) { try { obj.wsClient.send(data); } catch (ex) { } } };

                    // Connect the SSH module to the serial tunnel
                    var connectionOptions = { sock: obj.ser }
                    if (typeof obj.username == 'string') { connectionOptions.username = obj.username; }
                    if (typeof obj.password == 'string') { connectionOptions.password = obj.password; }
                    obj.sshClient.connect(connectionOptions);

                    // We are all set, start receiving data
                    ws._socket.resume();
                } else {
                    // Relay WS --> SSH
                    if ((data.length > 0) && (obj.ser != null)) { try { obj.ser.updateBuffer(data); } catch (ex) { console.log(ex); } }
                }
            });
            obj.wsClient.on('close', function () {
                if (obj.connected !== true) { try { obj.ws.send(JSON.stringify({ action: 'connectionerror' })); } catch (ex) { } }
                parent.parent.debug('relay', 'SSH: Relay websocket closed'); obj.close();
            });
            obj.wsClient.on('error', function (err) { parent.parent.debug('relay', 'SSH: Relay websocket error: ' + err); obj.close(); });
        } catch (ex) {
            console.log(ex);
        }
    }

    // When data is received from the web socket
    // SSH default port is 22
    ws.on('message', function (msg) {
        try {
            if (typeof msg != 'string') return;
            if (msg[0] == '{') {
                // Control data
                msg = JSON.parse(msg);
                if (typeof msg.action != 'string') return;
                switch (msg.action) {
                    case 'sshauth': {
                        // Verify inputs
                        if ((typeof msg.username != 'string') || (typeof msg.password != 'string')) break;
                        if ((typeof msg.rows != 'number') || (typeof msg.cols != 'number') || (typeof msg.height != 'number') || (typeof msg.width != 'number')) break;

                        obj.keep = msg.keep; // If true, keep store credentials on the server if the SSH tunnel connected succesfully.
                        obj.termSize = msg;
                        obj.username = msg.username;
                        obj.password = msg.password;

                        // Create a mesh relay authentication cookie
                        var cookieContent = { userid: user._id, domainid: user.domain, nodeid: obj.nodeid, tcpport: obj.tcpport };
                        if (obj.mtype == 3) { cookieContent.lc = 1; } // This is a local device
                        startRelayConnection(parent.parent.encodeCookie(cookieContent, parent.parent.loginCookieEncryptionKey));
                        break;
                    }
                    case 'sshautoauth': {
                        // Verify inputs
                        if ((typeof msg.rows != 'number') || (typeof msg.cols != 'number') || (typeof msg.height != 'number') || (typeof msg.width != 'number')) break;
                        obj.termSize = msg;

                        if ((obj.username == null) || (obj.password == null)) return;

                        // Create a mesh relay authentication cookie
                        var cookieContent = { userid: user._id, domainid: user.domain, nodeid: obj.nodeid, tcpport: obj.tcpport };
                        if (obj.mtype == 3) { cookieContent.lc = 1; } // This is a local device
                        startRelayConnection(parent.parent.encodeCookie(cookieContent, parent.parent.loginCookieEncryptionKey));
                        break;
                    }
                    case 'resize': {
                        // Verify inputs
                        if ((typeof msg.rows != 'number') || (typeof msg.cols != 'number') || (typeof msg.height != 'number') || (typeof msg.width != 'number')) break;

                        obj.termSize = msg;
                        if (obj.sshShell != null) { obj.sshShell.setWindow(obj.termSize.rows, obj.termSize.cols, obj.termSize.height, obj.termSize.width); }
                        break;
                    }
                }
            } else if (msg[0] == '~') {
                // Terminal data
                if (obj.sshShell != null) { obj.sshShell.write(msg.substring(1)); }
            }
        } catch (ex) { obj.close(); }
    });

    // If error, do nothing
    ws.on('error', function (err) { parent.parent.debug('relay', 'SSH: Browser websocket error: ' + err); obj.close(); });

    // If the web socket is closed
    ws.on('close', function (req) { parent.parent.debug('relay', 'SSH: Browser websocket closed'); obj.close(); });

    // Check that we have a user and nodeid
    if ((user == null) || (req.query.nodeid == null)) { obj.close(); return; } // Invalid nodeid
    parent.GetNodeWithRights(domain, user, req.query.nodeid, function (node, rights, visible) {
        // Check permissions
        if ((rights & 8) == 0) { obj.close(); return; } // No MESHRIGHT_REMOTECONTROL rights
        if ((rights != 0xFFFFFFFF) && (rights & 0x00000200)) { obj.close(); return; } // MESHRIGHT_NOTERMINAL is set
        obj.mtype = node.mtype; // Store the device group type
        obj.nodeid = node._id; // Store the NodeID

        // Check the SSH port
        obj.tcpport = 22;
        if (typeof node.sshport == 'number') { obj.tcpport = node.sshport; }

        // We are all set, start receiving data
        ws._socket.resume();

        // Check if we have SSH credentials for this device
        parent.parent.db.Get(obj.nodeid, function (err, nodes) {
            if ((err != null) || (nodes == null) || (nodes.length != 1)) return;
            const node = nodes[0];

            if ((node.ssh == null) || (typeof node.ssh != 'object') || (typeof node.ssh.u != 'string') || (typeof node.ssh.p != 'string')) {
                // Send a request for SSH authentication
                try { ws.send(JSON.stringify({ action: 'sshauth' })) } catch (ex) { }
            } else {
                // Use our existing credentials
                obj.username = node.ssh.u;
                obj.password = node.ssh.p;
                try { ws.send(JSON.stringify({ action: 'sshautoauth' })) } catch (ex) { }
            }
        });

    });

    return obj;
};



// Construct a SSH Files Relay object, called upon connection
module.exports.CreateSshFilesRelay = function (parent, db, ws, req, domain, user, cookie, args) {
    const Net = require('net');
    const WebSocket = require('ws');

    // SerialTunnel object is used to embed SSH within another connection.
    function SerialTunnel(options) {
        var obj = new require('stream').Duplex(options);
        obj.forwardwrite = null;
        obj.updateBuffer = function (chunk) { this.push(chunk); };
        obj._write = function (chunk, encoding, callback) { if (obj.forwardwrite != null) { obj.forwardwrite(chunk); } if (callback) callback(); }; // Pass data written to forward
        obj._read = function (size) { }; // Push nothing, anything to read should be pushed from updateBuffer()
        obj.destroy = function () { delete obj.forwardwrite; }
        return obj;
    }

    const obj = {};
    obj.ws = ws;
    obj.path = require('path');
    obj.relayActive = false;
    obj.firstMessage = true;

    parent.parent.debug('relay', 'SSH: Request for SSH files relay (' + req.clientIp + ')');

    // Disconnect
    obj.close = function (arg) {
        if (obj.ws == null) return;

        // Collect how many raw bytes where received and sent.
        // We sum both the websocket and TCP client in this case.
        //var inTraffc = obj.ws._socket.bytesRead, outTraffc = obj.ws._socket.bytesWritten;
        //if (obj.wsClient != null) { inTraffc += obj.wsClient._socket.bytesRead; outTraffc += obj.wsClient._socket.bytesWritten; }
        //console.log('WinSSH - in', inTraffc, 'out', outTraffc);

        if (obj.sshClient) {
            obj.sshClient.destroy();
            obj.sshClient.removeAllListeners('ready');
            try { obj.sshClient.end(); } catch (ex) { console.log(ex); }
            delete obj.sshClient;
        }
        if (obj.wsClient) {
            obj.wsClient.removeAllListeners('open');
            obj.wsClient.removeAllListeners('message');
            obj.wsClient.removeAllListeners('close');
            try { obj.wsClient.close(); } catch (ex) { console.log(ex); }
            delete obj.wsClient;
        }

        if ((arg == 1) || (arg == null)) { try { ws.close(); } catch (ex) { console.log(ex); } } // Soft close, close the websocket
        if (arg == 2) { try { ws._socket._parent.end(); } catch (ex) { console.log(ex); } } // Hard close, close the TCP socket
        obj.ws.removeAllListeners();

        obj.relayActive = false;
        delete obj.cookie;
        delete obj.sftp;
        delete obj.ws;
    };

    // Save SSH credentials into device
    function saveSshCredentials() {
        parent.parent.db.Get(obj.nodeid, function (err, nodes) {
            if ((err != null) || (nodes == null) || (nodes.length != 1)) return;
            const node = nodes[0];
            const changed = (node.ssh == null);

            // Save the credentials
            node.ssh = { u: obj.username, p: obj.password };
            parent.parent.db.Set(node);

            // Event node change if needed
            if (changed) {
                // Event the node change
                var event = { etype: 'node', action: 'changenode', nodeid: obj.nodeid, domain: domain.id, userid: user._id, username: user.name, node: parent.CloneSafeNode(node), msg: "Changed SSH credentials" };
                if (parent.parent.db.changeStream) { event.noact = 1; } // If DB change stream is active, don't use this event to change the node. Another event will come.
                parent.parent.DispatchEvent(parent.CreateMeshDispatchTargets(node.meshid, [obj.nodeid]), obj, event);
            }
        });
    }

    // Start the looppback server
    function startRelayConnection(authCookie) {
        try {
            // Setup the correct URL with domain and use TLS only if needed.
            var options = { rejectUnauthorized: false };
            if (domain.dns != null) { options.servername = domain.dns; }
            var protocol = 'wss';
            if (args.tlsoffload) { protocol = 'ws'; }
            var domainadd = '';
            if ((domain.dns == null) && (domain.id != '')) { domainadd = domain.id + '/' }
            var url = protocol + '://127.0.0.1:' + args.port + '/' + domainadd + ((obj.mtype == 3) ? 'local' : 'mesh') + 'relay.ashx?noping=1&p=11&auth=' + authCookie // Protocol 11 is Web-SSH
            parent.parent.debug('relay', 'SSH: Connection websocket to ' + url);
            obj.wsClient = new WebSocket(url, options);
            obj.wsClient.on('open', function () { parent.parent.debug('relay', 'SSH: Relay websocket open'); });
            obj.wsClient.on('message', function (data) { // Make sure to handle flow control.
                if ((obj.relayActive == false) && (data == 'c')) {
                    obj.relayActive = true;

                    // Create a serial tunnel && SSH module
                    obj.ser = new SerialTunnel();
                    const Client = require('ssh2').Client;
                    obj.sshClient = new Client();
                    obj.sshClient.on('ready', function () { // Authentication was successful.
                        // If requested, save the credentials
                        if (obj.keep === true) saveSshCredentials();
                        obj.sshClient.sftp(function(err, sftp) {
                            if (err) { obj.close(); return; }
                            obj.connected = true;
                            obj.sftp = sftp;
                            obj.ws.send('c');
                        });
                    });
                    obj.sshClient.on('error', function (err) {
                        if (err.level == 'client-authentication') { try { obj.ws.send(JSON.stringify({ action: 'autherror' })); } catch (ex) { } }
                        if (err.level == 'client-timeout') { try { obj.ws.send(JSON.stringify({ action: 'sessiontimeout' })); } catch (ex) { } }
                        obj.close();
                    });

                    // Setup the serial tunnel, SSH ---> Relay WS
                    obj.ser.forwardwrite = function (data) { if ((data.length > 0) && (obj.wsClient != null)) { try { obj.wsClient.send(data); } catch (ex) { } } };

                    // Connect the SSH module to the serial tunnel
                    var connectionOptions = { sock: obj.ser }
                    if (typeof obj.username == 'string') { connectionOptions.username = obj.username; }
                    if (typeof obj.password == 'string') { connectionOptions.password = obj.password; }
                    obj.sshClient.connect(connectionOptions);

                    // We are all set, start receiving data
                    ws._socket.resume();
                } else {
                    // Relay WS --> SSH
                    if ((data.length > 0) && (obj.ser != null)) { try { obj.ser.updateBuffer(data); } catch (ex) { console.log(ex); } }
                }
            });
            obj.wsClient.on('close', function () {
                if (obj.connected !== true) { try { obj.ws.send(JSON.stringify({ action: 'connectionerror' })); } catch (ex) { } }
                parent.parent.debug('relay', 'SSH: Files relay websocket closed'); obj.close();
            });
            obj.wsClient.on('error', function (err) { parent.parent.debug('relay', 'SSH: Files relay websocket error: ' + err); obj.close(); });
        } catch (ex) {
            console.log(ex);
        }
    }

    // When data is received from the web socket
    // SSH default port is 22
    ws.on('message', function (msg) {
        //if ((obj.firstMessage === true) && (msg != 5)) { obj.close(); return; } else { delete obj.firstMessage; }
        try {
            if (typeof msg != 'string') {
                if (msg[0] == 123) {
                    msg = msg.toString();
                } else if ((obj.sftp != null) && (obj.uploadHandle != null)) {
                    var off = (msg[0] == 0) ? 1 : 0;
                    obj.sftp.write(obj.uploadHandle, msg, off, msg.length - off, obj.uploadPosition, function (err) {
                        if (err != null) {
                            obj.sftp.close(obj.uploadHandle, function () { });
                            try { obj.ws.send(Buffer.from(JSON.stringify({ action: 'uploaddone', reqid: obj.uploadReqid }))) } catch (ex) { }
                            delete obj.uploadHandle;
                            delete obj.uploadFullpath;
                            delete obj.uploadSize;
                            delete obj.uploadReqid;
                            delete obj.uploadPosition;
                        } else {
                            try { obj.ws.send(Buffer.from(JSON.stringify({ action: 'uploadack', reqid: obj.uploadReqid }))) } catch (ex) { }
                        }
                    });
                    obj.uploadPosition += (msg.length - off);
                    return;
                }
            }
            if (msg[0] == '{') {
                // Control data
                msg = JSON.parse(msg);
                if (typeof msg.action != 'string') return;
                switch (msg.action) {
                    case 'ls': {
                        if (obj.sftp == null) return;
                        var requestedPath = msg.path;
                        if (requestedPath.startsWith('/') == false) { requestedPath = '/' + requestedPath; }
                        obj.sftp.readdir(requestedPath, function(err, list) {
                            if (err) { console.log(err); obj.close(); }
                            var r = { path: requestedPath, reqid: msg.reqid, dir: [] };
                            for (var i in list) {
                                var file = list[i];
                                if (file.longname[0] == 'd') { r.dir.push({ t: 2, n: file.filename, d: new Date(file.attrs.mtime * 1000).toISOString() }); }
                                else { r.dir.push({ t: 3, n: file.filename, d: new Date(file.attrs.mtime * 1000).toISOString(), s: file.attrs.size }); }
                            }
                            try { obj.ws.send(Buffer.from(JSON.stringify(r))) } catch (ex) { }
                        });
                        break;
                    }
                    case 'mkdir': {
                        if (obj.sftp == null) return;
                        var requestedPath = msg.path;
                        if (requestedPath.startsWith('/') == false) { requestedPath = '/' + requestedPath; }
                        obj.sftp.mkdir(requestedPath, function (err) { });

                        // Event the file delete
                        var targets = ['*', 'server-users'];
                        if (user.groups) { for (var i in user.groups) { targets.push('server-users:' + i); } }
                        parent.parent.DispatchEvent(targets, obj, { etype: 'node', action: 'agentlog', nodeid: obj.nodeid, userid: user._id, username: user.name, msgid: 44, msgArgs: [requestedPath], msg: 'Create folder: \"' + requestedPath + '\"', domain: domain.id });
                        break;
                    }
                    case 'rm': {
                        if (obj.sftp == null) return;
                        var requestedPath = msg.path;
                        if (requestedPath.startsWith('/') == false) { requestedPath = '/' + requestedPath; }
                        for (var i in msg.delfiles) {
                            const ul = obj.path.join(requestedPath, msg.delfiles[i]).split('\\').join('/');
                            obj.sftp.unlink(ul, function (err) { });
                            if (msg.rec === true) { obj.sftp.rmdir(ul + '/', function (err) { }); }

                            // Event the file delete
                            var targets = ['*', 'server-users'];
                            if (user.groups) { for (var i in user.groups) { targets.push('server-users:' + i); } }
                            parent.parent.DispatchEvent(targets, obj, { etype: 'node', action: 'agentlog', nodeid: obj.nodeid, userid: user._id, username: user.name, msgid: 45, msgArgs: [ul], msg: 'Delete: \"' + ul + '\"', domain: domain.id });
                        }

                        break;
                    }
                    case 'rename': {
                        if (obj.sftp == null) return;
                        var requestedPath = msg.path;
                        if (requestedPath.startsWith('/') == false) { requestedPath = '/' + requestedPath; }
                        const oldpath = obj.path.join(requestedPath, msg.oldname).split('\\').join('/');
                        const newpath = obj.path.join(requestedPath, msg.newname).split('\\').join('/');
                        obj.sftp.rename(oldpath, newpath, function (err) { });

                        // Event the file rename
                        var targets = ['*', 'server-users'];
                        if (user.groups) { for (var i in user.groups) { targets.push('server-users:' + i); } }
                        parent.parent.DispatchEvent(targets, obj, { etype: 'node', action: 'agentlog', nodeid: obj.nodeid, userid: user._id, username: user.name, msgid: 48, msgArgs: [oldpath, msg.newname], msg: 'Rename: \"' + oldpath + '\" to \"' + msg.newname + '\"', domain: domain.id });
                        break;
                    }
                    case 'upload': {
                        if (obj.sftp == null) return;
                        var requestedPath = msg.path;
                        if (requestedPath.startsWith('/') == false) { requestedPath = '/' + requestedPath; }
                        obj.uploadFullpath = obj.path.join(requestedPath, msg.name).split('\\').join('/');
                        obj.uploadSize = msg.size;
                        obj.uploadReqid = msg.reqid;
                        obj.uploadPosition = 0;
                        obj.sftp.open(obj.uploadFullpath, 'w', 0o666, function (err, handle) {
                            if (err != null) {
                                try { obj.ws.send(Buffer.from(JSON.stringify({ action: 'uploaderror', reqid: obj.uploadReqid }))) } catch (ex) { }
                            } else {
                                obj.uploadHandle = handle;
                                try { obj.ws.send(Buffer.from(JSON.stringify({ action: 'uploadstart', reqid: obj.uploadReqid }))) } catch (ex) { }

                                // Event the file upload
                                var targets = ['*', 'server-users'];
                                if (user.groups) { for (var i in user.groups) { targets.push('server-users:' + i); } }
                                parent.parent.DispatchEvent(targets, obj, { etype: 'node', action: 'agentlog', nodeid: obj.nodeid, userid: user._id, username: user.name, msgid: 105, msgArgs: [obj.uploadFullpath, obj.uploadSize], msg: 'Upload: ' + obj.uploadFullpath + ', Size: ' + obj.uploadSize, domain: domain.id });
                            }
                        });
                        break;
                    }
                    case 'uploaddone': {
                        if (obj.sftp == null) return;
                        if (obj.uploadHandle != null) {
                            obj.sftp.close(obj.uploadHandle, function () { });
                            try { obj.ws.send(Buffer.from(JSON.stringify({ action: 'uploaddone', reqid: obj.uploadReqid }))) } catch (ex) { }
                            delete obj.uploadHandle;
                            delete obj.uploadFullpath;
                            delete obj.uploadSize;
                            delete obj.uploadReqid;
                            delete obj.uploadPosition;
                        }
                        break;
                    }
                    case 'uploadcancel': {
                        if (obj.sftp == null) return;
                        if (obj.uploadHandle != null) {
                            obj.sftp.close(obj.uploadHandle, function () { });
                            obj.sftp.unlink(obj.uploadFullpath, function (err) { });
                            try { obj.ws.send(Buffer.from(JSON.stringify({ action: 'uploadcancel', reqid: obj.uploadReqid }))) } catch (ex) { }
                            delete obj.uploadHandle;
                            delete obj.uploadFullpath;
                            delete obj.uploadSize;
                            delete obj.uploadReqid;
                            delete obj.uploadPosition;
                        }
                        break;
                    }
                    case 'download': {
                        if (obj.sftp == null) return;
                        switch (msg.sub) {
                            case 'start': {
                                var requestedPath = msg.path;
                                if (requestedPath.startsWith('/') == false) { requestedPath = '/' + requestedPath; }
                                obj.downloadFullpath = requestedPath;
                                obj.downloadId = msg.id;
                                obj.downloadPosition = 0;
                                obj.downloadBuffer = Buffer.alloc(16384);
                                obj.sftp.open(obj.downloadFullpath, 'r', function (err, handle) {
                                    if (err != null) {
                                        try { obj.ws.send(Buffer.from(JSON.stringify({ action: 'download', sub: 'cancel', id: obj.downloadId }))) } catch (ex) { }
                                    } else {
                                        obj.downloadHandle = handle;
                                        try { obj.ws.send(JSON.stringify({ action: 'download', sub: 'start', id: obj.downloadId })) } catch (ex) { }

                                        // Event the file download
                                        var targets = ['*', 'server-users'];
                                        if (user.groups) { for (var i in user.groups) { targets.push('server-users:' + i); } }
                                        parent.parent.DispatchEvent(targets, obj, { etype: 'node', action: 'agentlog', nodeid: obj.nodeid, userid: user._id, username: user.name, msgid: 49, msgArgs: [obj.downloadFullpath], msg: 'Download: ' + obj.downloadFullpath, domain: domain.id });
                                    }
                                });
                                break;
                            }
                            case 'startack': {
                                if ((obj.downloadHandle == null) || (obj.downloadId != msg.id)) break;
                                obj.downloadPendingBlockCount = (typeof msg.ack == 'number') ? msg.ack : 8;
                                uploadNextBlock();
                                break;
                            }
                            case 'ack': {
                                if ((obj.downloadHandle == null) || (obj.downloadId != msg.id)) break;
                                if (obj.downloadPendingBlockCount == 0) { obj.downloadPendingBlockCount = 1; uploadNextBlock(); }
                                break;
                            }
                            case 'stop': {
                                if ((obj.downloadHandle == null) || (obj.downloadId != msg.id)) break;
                                if (obj.downloadHandle != null) { obj.sftp.close(obj.downloadHandle, function () { }); }
                                delete obj.downloadId;
                                delete obj.downloadBuffer;
                                delete obj.downloadHandle;
                                delete obj.downloadFullpath;
                                delete obj.downloadPosition;
                                delete obj.downloadPendingBlockCount;
                                break;
                            }
                        }
                        break;
                    }
                    case 'sshauth': {
                        if (obj.sshClient != null) return;

                        // Verify inputs
                        if ((typeof msg.username != 'string') || (typeof msg.password != 'string')) break;

                        obj.keep = (msg.keep === true); // If true, keep store credentials on the server if the SSH tunnel connected succesfully.
                        obj.username = msg.username;
                        obj.password = msg.password;

                        // Create a mesh relay authentication cookie
                        var cookieContent = { userid: user._id, domainid: user.domain, nodeid: obj.nodeid, tcpport: obj.tcpport };
                        if (obj.mtype == 3) { cookieContent.lc = 1; } // This is a local device
                        startRelayConnection(parent.parent.encodeCookie(cookieContent, parent.parent.loginCookieEncryptionKey));
                        break;
                    }
                }
            }
        } catch (ex) { obj.close(); }
    });

    function uploadNextBlock() {
        if (obj.downloadBuffer == null) return;
        obj.sftp.read(obj.downloadHandle, obj.downloadBuffer, 4, obj.downloadBuffer.length - 4, obj.downloadPosition, function (err, len, buf) {
            obj.downloadPendingBlockCount--;
            if (obj.downloadBuffer == null) return;
            if (err != null) {
                try { obj.ws.send(Buffer.from(JSON.stringify({ action: 'download', sub: 'cancel', id: obj.downloadId }))) } catch (ex) { }
            } else {
                obj.downloadPosition += len;
                if (len < (obj.downloadBuffer.length - 4)) {
                    obj.downloadBuffer.writeInt32BE(0x01000001, 0)
                    if (len > 0) { try { obj.ws.send(obj.downloadBuffer.slice(0, len + 4)); } catch (ex) { console.log(ex); } }
                } else {
                    obj.downloadBuffer.writeInt32BE(0x01000000, 0);
                    try { obj.ws.send(obj.downloadBuffer.slice(0, len + 4)); } catch (ex) { console.log(ex); }
                    if (obj.downloadPendingBlockCount > 0) { uploadNextBlock(); }
                    return;
                }
            }
            if (obj.downloadHandle != null) { obj.sftp.close(obj.downloadHandle, function () { }); }
            delete obj.downloadId;
            delete obj.downloadBuffer;
            delete obj.downloadHandle;
            delete obj.downloadFullpath;
            delete obj.downloadPosition;
            delete obj.downloadPendingBlockCount;
        });
    }

    // If error, do nothing
    ws.on('error', function (err) { parent.parent.debug('relay', 'SSH: Browser websocket error: ' + err); obj.close(); });

    // If the web socket is closed
    ws.on('close', function (req) { parent.parent.debug('relay', 'SSH: Browser websocket closed'); obj.close(); });

    // Check that we have a user and nodeid
    if ((user == null) || (req.query.nodeid == null)) { obj.close(); return; } // Invalid nodeid
    parent.GetNodeWithRights(domain, user, req.query.nodeid, function (node, rights, visible) {
        // Check permissions
        if ((rights & 8) == 0) { obj.close(); return; } // No MESHRIGHT_REMOTECONTROL rights
        if ((rights != 0xFFFFFFFF) && (rights & 0x00000200)) { obj.close(); return; } // MESHRIGHT_NOTERMINAL is set
        obj.mtype = node.mtype; // Store the device group type
        obj.nodeid = node._id; // Store the NodeID

        // Check the SSH port
        obj.tcpport = 22;
        if (typeof node.sshport == 'number') { obj.tcpport = node.sshport; }

        // We are all set, start receiving data
        ws._socket.resume();

        // Check if we have SSH credentials for this device
        parent.parent.db.Get(obj.nodeid, function (err, nodes) {
            if ((err != null) || (nodes == null) || (nodes.length != 1)) return;
            const node = nodes[0];

            if ((node.ssh == null) || (typeof node.ssh != 'object') || (typeof node.ssh.u != 'string') || (typeof node.ssh.p != 'string')) {
                // Send a request for SSH authentication
                try { ws.send(JSON.stringify({ action: 'sshauth' })) } catch (ex) { }
            } else {
                // Use our existing credentials
                obj.username = node.ssh.u;
                obj.password = node.ssh.p;

                // Create a mesh relay authentication cookie
                var cookieContent = { userid: user._id, domainid: user.domain, nodeid: obj.nodeid, tcpport: obj.tcpport };
                if (obj.mtype == 3) { cookieContent.lc = 1; } // This is a local device
                startRelayConnection(parent.parent.encodeCookie(cookieContent, parent.parent.loginCookieEncryptionKey));
            }
        });

    });

    return obj;
};
