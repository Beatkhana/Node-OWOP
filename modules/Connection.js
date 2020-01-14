const request = require("request")
const Client = require('./connection/player/Client.js');
var config = require("../config");
const protocol = require("./server/protocol.js");
const captchaStates = require("./connection/captcha/captchaStates.js");
const worldTemplate = require("./connection/world/worldTemplate.js");
const permissions = require("./connection/player/permissions.js")
const Case = require('./connection/player/cases.js');
const Bucket = require("./connection/player/Bucket.js")
const Commands = require("./connection/commands/Commands.js")
const Captcha = require("./connection/captcha/Captcha.js");

class Connection {
  constructor(ws, req, worlds, bans, manager, updateClock) {
    this.ws = ws;
    this.req = req;
    this.bans = bans
    this.manager = manager
    this.worlds = worlds
    this.world = null;
    this.client = new Client(ws, req);
    this.updateClock = updateClock
    this.player = false
    this.captcha = new Captcha(this.client, this.worlds);

    ws.on("message", this.onMessage.bind(this));
    ws.on("close", this.onClose.bind(this));
    ws.on("error", this.onError.bind(this));

		this.captcha.show()
  }
  onMessage(message) {
    var data = new Uint8Array(message)
    var dv = new DataView(data.buffer)
    var len = message.length;
    var isBinary = (typeof message == "object");
    if (this.player && isBinary && this.captcha.state == "ok") {
      //cases
      new Case(message, this.client, this.world, this.worlds, this.manager, this.updateClock)
    } else if (this.player && !isBinary && this.captcha.state == "ok") {
      if (!this.client.chatBucket.canSpend(1)) return;
      var tmpIsStaff = this.client.rank > permissions.user
      var tmpIsMod = this.client.rank == permissions.mod
      var tmpIsAdmin = this.client.rank == permissions.admin
      var before = "";
      if (this.client.stealth) {
        tmpIsAdmin = false;
        tmpIsMod = false;
        tmpIsStaff = false;
      }
      if (tmpIsAdmin) before += "(A) ";
      if (tmpIsMod) before += "(M) ";
      if (this.client.nick && !tmpIsStaff) {
        before += `[${this.client.id}] ${this.client.nick}`;
      } else if (this.client.nick && tmpIsStaff) {
        before += this.client.nick;
      }
      if (!this.client.nick) {
        before += this.client.id;
      }
      this.client.before = before
      if (len > 1 && message[len - 1] == String.fromCharCode(10)) {
        var chat = message.slice(0, len - 1).trim();
        console.log(`World name: ${this.client.world} id/nick: ${before} ip: ${this.client.ip} message: ${chat}`);
        if (chat.length <= 512 || this.client.rank > permissions.user) {
          if (chat[0] == "/") {
            new Commands(chat, this.client, this.world, this.worlds, this.manager)
          } else {
            this.world.sendToAll(before + ": " + chat);
						server.events.emit("chat", this.client, chat)
          }
        }
      }
    } else if (!this.player && isBinary && this.captcha.state == "ok") {

      //player on real connect
      if (len > 2 && len - 2 <= 24 /*&& dv.getUint16(len - 2, true) == 1234 //world verification*/ ) {
        if (config.antiproxy) {
          request("http://proxycheck.io/v2/" + this.client.ip, function(error, response, body) {
            body = body.replace(/\r/g, '');
            var isproxy = JSON.parse(body).proxy;
            if (isproxy == "yes") {
              this.client.send("Proxy detected!");
              this.client.ws.close()
              return;
            }
          }.bind(this))
        }

        for (var i = 0; i < data.length - 2; i++) {
          this.client.world += String.fromCharCode(data[i]);
        }
        this.client.world = this.client.world.replace(/[^a-zA-Z0-9\._]/gm, "").toLowerCase();
        if (!this.client.world) this.client.world = "main";
        this.world = this.worlds.find(function(world) {
          return world.name == this.client.world
        }.bind(this));
        if (!this.world) {
          this.manager.world_init(this.client.world)
          this.world = new worldTemplate(this.client.world);
          this.worlds.push(this.world)
					server.events.emit("newWorld", this.world)
        }

        this.client.setRank(permissions.user)

        var pass = this.manager.get_prop(this.world.name, "pass");
        if (pass) {
          this.client.send(" [Server] This world has a password set. Use '/pass PASSWORD' to unlock drawing.")
          this.client.setRank(permissions.none)
        }

        this.client.send(this.manager.get_prop(this.world.name, "motd"))
        this.client.setId(this.world.latestId)
        this.world.latestId++
        this.player = true;
        this.world.clients.push(this.client);
				server.events.emit("join", this.client)

        // send client list to that client
        this.updateClock.doUpdatePlayerPos(this.world.name, {
          id: this.client.id,
          x: 0,
          y: 0,
          r: 0,
          g: 0,
          b: 0,
          tool: 0
        })
        for (var w in this.world.clients) {
          var cli = this.world.clients[w];
          var upd = {
            id: cli.id,
            x: cli.x_pos,
            y: cli.y_pos,
            r: cli.col_r,
            g: cli.col_g,
            b: cli.col_b,
            tool: cli.tool
          };
          this.updateClock.doUpdatePlayerPos(this.world.name, upd)
        }
      }

    } else if (!this.player && !isBinary && this.captcha.state == "waiting") {
      this.captcha.onToken(message)
    }
  }
  onClose() {
    if (!this.world) return;
    if (!this.client) return;
		server.events.emit("leave", this.client)
    var worldIndex = this.worlds.indexOf(this.world);
    var clIdx = this.world.clients.indexOf(this.client);
    if (clIdx > -1) {
      this.updateClock.doUpdatePlayerLeave(this.world.name, this.client.id)
      delete this.world.clients[clIdx]
      this.world.clients.sort().pop()
    }
    if (!this.world.clients.length) {
      this.manager.world_unload()
      delete this.worlds[worldIndex]
      this.worlds.sort().pop()
    }
  }
  onError(error) {
    console.log(error);
  }
}
module.exports = Connection
