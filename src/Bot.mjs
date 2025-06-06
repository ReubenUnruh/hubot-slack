import { Adapter, EnterMessage, LeaveMessage } from 'hubot'
import { SlackTextMessage, ReactionMessage, FileSharedMessage } from './Message.mjs'
import { SocketModeClient } from '@slack/socket-mode' 
import { WebClient } from '@slack/web-api'
import pkg from '../package.json' with { type: 'json' }

class SlackClient {
  static CONVERSATION_CACHE_TTL_MS =
    process.env.HUBOT_SLACK_CONVERSATION_CACHE_TTL_MS
    ? parseInt(process.env.HUBOT_SLACK_CONVERSATION_CACHE_TTL_MS, 10)
    : (5 * 60 * 1000);
  constructor(options, robot, socket, web) {
    this.robot = robot;
    this.socket = socket ?? new SocketModeClient({ appToken: options.appToken, ...options.socketModeOptions });
    this.web = web ?? new WebClient(options.botToken, { maxRequestConcurrency: 1, logLevel: 'error'});
    this.apiPageSize = 100;
    if (!isNaN(options.apiPageSize)) {
      this.apiPageSize = parseInt(options.apiPageSize, 10);
    }

    this.robot.logger.debug(`SocketModeClient initialized with options: ${JSON.stringify(options.socketModeOptions) ?? ''}`);

    // Map to convert bot user IDs (BXXXXXXXX) to user representations for events from custom
    // integrations and apps without a bot user
    this.botUserIdMap = {
      "B01": { id: "B01", user_id: "USLACKBOT" }
    };

    // Map to convert conversation IDs to conversation representations
    this.channelData = {};

    // Event handling
    // NOTE: add channel join and leave events
    this.socket.on("authenticated", this.eventWrapper, this);
    this.socket.on("message", this.eventWrapper, this);
    this.socket.on("reaction_added", this.eventWrapper, this);
    this.socket.on("reaction_removed", this.eventWrapper, this);
    this.socket.on("member_joined_channel", this.eventWrapper, this);
    this.socket.on("member_left_channel", this.eventWrapper, this);
    this.socket.on("file_shared", this.eventWrapper, this);
    this.socket.on("user_change", this.updateUserInBrain, this);
    this.eventHandler = undefined;
  }

  async connect() {
    this.robot.logger.debug(`Calling SocketModeClient#start()`);
    const response = await this.socket.start();
    return response;
  }
  onEvent(callback) {
    if (this.eventHandler !== callback) { return this.eventHandler = callback; }
  }

  disconnect() {
    this.socket.disconnect();
    return this.socket.removeAllListeners();
  }

  async setTopic(conversationId, topic) {
    this.robot.logger.debug(`SlackClient#setTopic() with topic ${topic}`);
    try {
      const res = await this.web.conversations.info({channel: conversationId})
      const conversation = res.channel;
      if (!conversation.is_im && !conversation.is_mpim) {
        return this.web.conversations.setTopic({channel: conversationId, topic});
      } else {
        return this.robot.logger.debug(`Conversation ${conversationId} is a DM or MPDM. These conversation types do not have topics.`);
      }
    } catch (error) {
      this.robot.logger.error(error, `Error setting topic in conversation ${conversationId}: ${error.message}`);
    }
  }
  async send(envelope, message) {
    const room = envelope.room || envelope.id;
    const thread_ts = envelope.message?.thread_ts
    if (room == null) {
      this.robot.logger.error("Cannot send message without a valid room. Envelopes should contain a room property set to a Slack conversation ID.");
      return;
    }
    this.robot.logger.debug(`SlackClient#send() room: ${room}, message: ${message}`);
    const messageOptions = {
      channel: room,
      text: typeof message === "string" ? message : message.text,
      thread_ts, // Include thread_ts if it's defined
      ...message, // Spread other properties from the message if it's an object
    };
  
    try {
      const result = await this.web.chat.postMessage(messageOptions);
      this.robot.logger.debug(`Successfully sent message to ${room}`);
    } catch (e) {
      this.robot.logger.error(e, `SlackClient#send() error: ${e.message}`);
    }
  }
  loadUsers(callback) {
    const combinedResults = { members: [] };
    var pageLoaded = (error, results) => {
      if (error) {
        return callback(error);
      }

      for (var member of results.members) {
        combinedResults.members.push(member);
      }

      if(results?.response_metadata?.next_cursor) {
        return this.web.users.list({
          limit: this.apiPageSize,
          cursor: results.response_metadata.next_cursor
        }, pageLoaded);
      } else {
        return callback(null, combinedResults);
      }
    };
    return this.web.users.list({ limit: this.apiPageSize }, pageLoaded);
  }

  async fetchUser(userId) {
    if (this.robot.brain.data.users[userId] != null) { return Promise.resolve(this.robot.brain.data.users[userId]); }
    const r = await this.web.users.info({user: userId});
    this.updateUserInBrain(r.user);
    return r.user;
  }
  async fetchConversation(conversationId) {
    const expiration = Date.now() - SlackClient.CONVERSATION_CACHE_TTL_MS;
    if (((this.channelData[conversationId] != null ? this.channelData[conversationId].channel : undefined) != null) &&
      (expiration < (this.channelData[conversationId] != null ? this.channelData[conversationId].updated : undefined))) { return Promise.resolve(this.channelData[conversationId].channel); }
    if (this.channelData[conversationId] != null) { delete this.channelData[conversationId]; }
    const r = await this.web.conversations.info({channel: conversationId})
    if (r.channel != null) {
      this.channelData[conversationId] = {
        channel: r.channel,
        updated: Date.now()
      };
    }
    return r.channel;
  }
  updateUserInBrain(event_or_user) {
    let key, value;
    const user = event_or_user.type === 'user_change' ? event_or_user.user : event_or_user;
    const newUser = {
      id: user.id,
      name: user.name,
      real_name: user.real_name,
      slack: {}
    };
    if ((user.profile != null ? user.profile.email : undefined) != null) { newUser.email_address = user.profile.email; }
    for (key in user) {
      value = user[key];
      newUser.slack[key] = value;
    }
    if (user.id in this.robot.brain.data.users) {
      for (key in this.robot.brain.data.users[user.id]) {
        value = this.robot.brain.data.users[user.id][key];
        if (!(key in newUser)) {
          newUser[key] = value;
        }
      }
    }
    delete this.robot.brain.data.users[user.id];
    return this.robot.brain.userForId(user.id, newUser);
  }
  async eventWrapper(event) {
    if(!this.eventHandler) return;
    try {
      await this.eventHandler(event);
    } catch (error) {
      this.robot.logger.error(error, `bot.js: eventWrapper: An error occurred while processing an event from SlackBot's SlackClient: ${error.message}.`);
    }
  }
}

if (SlackClient.CONVERSATION_CACHE_TTL_MS === NaN) {
  throw new Error('HUBOT_SLACK_CONVERSATION_CACHE_TTL_MS must be a number. It could not be parsed.');
}

class SlackBot extends Adapter {
  constructor(robot, options) {
    super(robot);
    this.options = options;
    this.robot.logger.info(`hubot-slack adapter v${pkg.version}`);
    this.socket = options.socket ?? new SocketModeClient({ appToken: options.appToken, ...options.socketModeOptions });
    this.web = new WebClient(options.botToken, { agent: robot.config?.agent ?? undefined, maxRequestConcurrency: 1, logLevel: 'error'});
    this.client = new SlackClient(this.options, this.robot, this.socket, this.web);
  }

  async run() {
    if (!this.options.botToken) {
      return this.robot.logger.error("No botToken provided to Hubot");
    }

    if (!this.options.appToken) {
      return this.robot.logger.error("No appToken provided to Hubot");
    }
    const needle = this.options.botToken.substring(0, 5);
    if (!["xoxb-", "xoxp-"].includes(needle)) {
      return this.robot.logger.error("Invalid botToken provided, please follow the upgrade instructions");
    }

    if (!["xapp-"].includes(this.options.appToken.substring(0, 5))) {
      return this.robot.logger.error("Invalid appToken provided, please follow the upgrade instructions");
    }

    this.client.socket.on("open", this.open.bind(this));
    this.client.socket.on("close", this.onSocketClose.bind(this));
    this.client.socket.on("error", this.error.bind(this));
    this.client.socket.on("authenticated", this.authenticated.bind(this));
    this.client.onEvent(this.eventHandler.bind(this));
    
    // Brain will emit 'loaded' the first time it connects to its storage and then again each time a key is set
    this.robot.brain.on("loaded", () => {
      if(this.brainIsLoaded) return;
      this.brainIsLoaded = true;
      // The following code should only run after the first time the brain connects to its storage

      // There's a race condition where the connection can happen after the above `@client.loadUsers` call finishes,
      // in which case the calls to save users in `@usersLoaded` would not persist. It is still necessary to call the
      // method there in the case Hubot is running without brain storage.
      // NOTE: is this actually true? won't the brain have the users in memory and persist to storage as soon as the
      // connection is complete?
      // NOTE: this seems wasteful. when there is brain storage, it will end up loading all the users twice.
      this.client.loadUsers(this.usersLoaded.bind(this));
      this.isLoaded = true;
    });

    // TODO: set this to false as soon as connection closes (even if reconnect will happen later)
    // TODO: check this value when connection finishes (even if its a reconnection)
    // TODO: build a map of enterprise users and local users
    this.needsUserListSync = true;
    if (!this.options.disableUserSync) {
      // Synchronize workspace users to brain
      this.client.loadUsers(this.usersLoaded.bind(this));
    } else {
      this.brainIsLoaded = true;
    }

    this.client.socket.on('connected', () => {
      this.emit('connected');
      this.robot.emit('connected')
    });

    // Start logging in
    await this.client.connect()
    this.robot.logger.info('Connected to Slack on run');
  }

  /**
   * Hubot is sending a message to Slack
   *
   * @public
   * @param {Object} envelope - fully documented in SlackClient
   * @param {...(string|Object)} messages - fully documented in SlackClient
   */
  async send(envelope, ...messages) {
    
    this.robot.logger.debug('Sending message to Slack');
    let callback = function() {};
    if (typeof(messages[messages.length - 1]) === "function") {
      callback = messages.pop();
    }
    const messagePromises = messages.map(message => {
      if (typeof(message) === "function") { return Promise.resolve(); }
      // NOTE: perhaps do envelope manipulation here instead of in the client (separation of concerns)
      if (message !== "") { return this.client.send(envelope, message); }
    });
    let results = [];
    try {
      results = await Promise.all(messagePromises)
      callback(null, null)
    } catch (e) {
      this.robot.logger.error(e);
      callback(e, null);
    }
    return results;
  }

  /**
   * Hubot is replying to a Slack message
   * @public
   * @param {Object} envelope - fully documented in SlackClient
   * @param {...(string|Object)} messages - fully documented in SlackClient
   */
  async reply(envelope, ...messages) {
    this.robot.logger.debug('replying to message');
    let callback = function() {};
    if (typeof(messages[messages.length - 1]) === "function") {
      callback = messages.pop();
    }
    const messagePromises = messages.map(message => {
      if (typeof(message) === "function") { 
        return Promise.resolve();
      }

      if (message !== "") {
        // TODO: channel prefix matching should be removed
        if (envelope.room[0] !== "D") { message = `<@${envelope.user.id}>: ${message}`; }
        return this.client.send(envelope, message);
      }
    });
    let results = [];
    try {
      results = await Promise.all(messagePromises)
      callback(null, null)
    } catch (e) {
      this.robot.logger.error(e);
      callback(e, null);
    }
    return results;
  }

  /**
   * Hubot is setting the Slack conversation topic
   * @public
   * @param {Object} envelope - fully documented in SlackClient
   * @param {...string} strings - strings that will be newline separated and set to the conversation topic
   */
  async setTopic(envelope, ...strings) {
    return await this.client.setTopic(envelope.room, strings.join("\n"));
  }

  /**
   * Hubot is sending a reaction
   * NOTE: the super class implementation is just an alias for send, but potentially, we can detect
   * if the envelope has a specific message and send a reactji. the fallback would be to just send the
   * emoji as a message in the channel
   */
  // emote: (envelope, strings...) ->


  /**
   * Slack client has opened the connection
   * @private
   */
  open() {
    this.robot.logger.info("Connected to Slack Socket");

    // Tell Hubot we're connected so it can load scripts
    return this.emit("connected");
  }

  /**
   * Slack client has authenticated
   *
   * @private
   * @param identity - the response from calling the Slack Web API method
   */
  async authenticated(identity) {
    if(this.self) return;
    this.self = await this.client.web.auth.test();
    this.robot.logger.debug(this.self);
    this.robot.name = this.self.user;
    return this.robot.logger.info(`Logged in as @${this.robot.name} in workspace ${this.self.team}`);
  }

  /**
   * Slack client has closed the connection
   * @private
   */
  onSocketClose() {
    if (this.socket.autoReconnectEnabled && !this.socket.shuttingDown) {
      this.robot.logger.info("Disconnected from Slack Socket");
      return this.robot.logger.info("Waiting for reconnect...");
    } else {
      return this.robot.logger.info("Disconnected from Slack Socket");
    }
  }

  /**
   * Close the connection
   * @private
   */
  close() {
    this.disconnect();
  }

  /**
   * Slack client has closed the connection and will not reconnect
   * @private
   */
  disconnect() {
    this.robot.logger.info("Disconnected from Slack Socket");
    this.robot.logger.info("Exiting...");
    this.client.disconnect();
  }

  /**
   * Slack client received an error
   *
   * @private
   * @param error - An error emitted
   */
  error(error) {
    this.robot.logger.error(error, `SlackBot error`);
    // Assume that scripts can handle slowing themselves down, all other errors are bubbled up through Hubot
    // NOTE: should rate limit errors also bubble up?
    if (error.code !== -1) {
      return this.robot.emit("error", error);
    }
  }

  replaceBotIdWithName(event) {
      const botId = this.self.user_id;
      const botName = this.self.user;
      const text = event.text ?? event.message?.text ?? '';
      if(text.includes(`<@${botId}>`)) {
        if(this.robot.alias) {
          return text.replace(`<@${botId}>`, `${this.robot.alias}`);
        } else {
          return text.replace(`<@${botId}>`, `@${botName}`);
        }
      }
      return text;
  }
  addBotIdToMessage(event) {
    let text = event.text ?? event.message?.text ?? '';
    if (text && event?.channel_type == 'im' && !text.includes(this.self.user_id)) {
      text = `<@${this.self.user_id}> ${text}`;
    }
    return text;
  }
  /**
   * Incoming Slack event handler
   *
   * This method is used to ingest Slack events and prepare them as Hubot Message objects. The messages are passed
   * to the Robot#receive() method, which allows executes receive middleware and eventually triggers the various
   * listeners that are created by scripts.
   *
   * Depending on the exact type of event, additional properties may be present. The following describes the "special"
   * ones that have meaningful handling across all types.
   *
   * @private
   * @param {Object} event
   * @param {string} event.type - this specifies the event type
   * @param {SlackUserInfo} [event.user] - the description of the user creating this event as returned by `users.info`
   * @param {string} [event.channel] - the conversation ID for where this event took place
   * @param {SlackBotInfo} [event.bot] - the description of the bot creating this event as returned by `bots.info`
   */
  async eventHandler(message) {
    this.robot.logger.debug(`eventHandler ${JSON.stringify(message, null, 2)}`);
    if (message?.ack) {
      await message?.ack();
    }

    if(!message?.body?.event?.user) {
      return;
    }

    let msg;
    const {user, channel} = message.event;
    const event_team_id = message.event.team;

    const userFromBrain = this.robot.brain.users()[user];
    if (!userFromBrain) {
      const userResponse = await this.client.web.users.info({
        user
      })
      this.robot.brain.userForId(user, userResponse.user);
    }

    const from = this.robot.brain.users()[user];

    // Ignore anything we sent
    if (from?.id === this.self.user_id) { 
      return ;
    }
    
    this.robot.logger.debug(`event ${JSON.stringify(message, null, 2)} user = ${user}`);

    // TODO: I don't know what the schema looks like for this so i'm commenting it out
    // until i can figure it out.
    // if (this.options.installedTeamOnly) {
    //   // Skip events generated by other workspace users in a shared channel
    //   if ((event_team_id != null) && (event_team_id !== this.self.installed_team_id)) {
    //     this.robot.logger.debug(`Skipped an event generated by an other workspace user (team: ${event_team_id}) in shared channel (channel: ${channel})`);
    //     return;
    //   }
    // }


    // Hubot expects all user objects to have a room property that is used in the envelope for the message after it
    // is received
    from.room = channel ?? '';
    from.name = from?.name ?? null;

    // add the bot id to the message if it's a direct message
    message.body.event.text = this.addBotIdToMessage(message.body.event);
    message.body.event.text = this.replaceBotIdWithName(message.body.event);
    this.robot.logger.debug(`Text = ${message.body.event.text}`);
    this.robot.logger.debug(`Event subtype = ${message.body.event?.subtype}`);

    try {
      switch (message.event.type) {
        case "member_joined_channel":
          // this event type always has a channel
          this.robot.logger.debug(`Received enter message for user: ${from.id}, joining: ${channel}`);
          msg = new EnterMessage(from);
          msg.ts = message.event.ts;
          await this.receive(msg);
          break;
        case "member_left_channel":
          this.robot.logger.debug(`Received leave message for user: ${from.id}, joining: ${channel}`);
          msg = new LeaveMessage(user);
          msg.ts = message.ts;
          await this.receive(msg);
          break;
        case "reaction_added": case "reaction_removed":
          // Once again Hubot expects all user objects to have a room property that is used in the envelope for the message
          // after it is received. If the reaction is to a message, then the `event.item.channel` contain a conversation ID.
          // Otherwise reactions can be on files and file comments, which are "global" and aren't contained in a
          // conversation. In that situation we fallback to an empty string.
          from.room = message.body.event.item.type === "message" ? message.body.event.item.channel : "";
  
          // Reaction messages may contain an `event.item_user` property containing a fetched SlackUserInfo object. Before
          // the message is received by Hubot, turn that data into a Hubot User object.
          const item_user = (message.body.event.item_user != null) ? this.robot.brain.userForId(message.body.event.item_user.id, message.body.event.item_user) : {};
  
          this.robot.logger.debug(`Received reaction message from: ${from.id}, reaction: ${message.body.event.reaction}, item type: ${message.body.event.item.type}`);
          await this.receive(new ReactionMessage(message.body.event.type, from, message.body.event.reaction, item_user, message.body.event.item, message.body.event.event_ts));
          break;
        case "file_shared":  
          this.robot.logger.debug(`Received file_shared message from: ${message.body.event.user_id}, file_id: ${message.body.event.file_id}`);
          await this.receive(new FileSharedMessage(from, message.body.event.file_id, message.body.event.event_ts));
          break;
        default:
          this.robot.logger.debug(`Received generic message: ${message.event.type}`);
          try {
            const msg = await SlackTextMessage.makeSlackTextMessage(from, null, message?.body?.event.text, message?.body?.event, channel, this.robot.name, this.robot.alias, this.client)
            await this.receive(msg);
          } catch (error) {
            this.robot.logger.error(error, `Dropping message due to error ${error.message}`);
          }
          break;
      }
    } catch (e) {
      this.robot.logger.error(e);
    }
  }

  /**
   * Callback for fetching all users in workspace. Delegates to `updateUserInBrain()` to write all users to Hubot brain
   *
   * @private
   * @param {Error} [error] - describes an error that occurred while fetching users
   * @param {SlackUsersList} [res] - the response from the Slack Web API method `users.list`
   */
  usersLoaded(err, res) {
    if (err || !res.members.length) {
      this.robot.logger.error("Can't fetch users");
      return;
    }
    return res.members.map((member) => this.client.updateUserInBrain(member));
  }
}
export { 
  SlackClient,
  SlackBot
}