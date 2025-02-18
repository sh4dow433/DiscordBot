require('dotenv').config(); // Load environment variables from .env file

const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { createAudioPlayer, createAudioResource, joinVoiceChannel, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const yts = require('yt-search');

// Add YouTube authentication
// play.setToken({
//     youtube: {
//         cookie: ''
//    }
// });

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
    ]
});

const prefix = '!';
const queue = new Map();

client.once('ready', () => {
    console.log('Bot is ready!');
});

client.on('messageCreate', async message => {
    if (!message.content.startsWith(prefix) || message.author.bot) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    const serverQueue = queue.get(message.guild.id);

    switch(command) {
        case 'help':
            try {
                const helpEmbed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Music Bot Commands')
                    .setDescription('Here are all available commands:')
                    .addFields([  // Note the array syntax here
                        { 
                            name: `${prefix}play <song name or URL>`, 
                            value: 'Plays a song from YouTube.\n' +
                                  'Examples:\n' +
                                  `\`${prefix}play https://www.youtube.com/watch?v=dQw4w9WgXcQ\`\n` +
                                  `\`${prefix}play never gonna give you up\`\n` +
                                  `\`${prefix}play rick astley never gonna give you up\``
                        },
                        { 
                            name: `${prefix}skip`, 
                            value: 'Skips the current song and plays the next song in the queue.\n' +
                                  'Example:\n' +
                                  `\`${prefix}skip\``
                        },
                        { 
                            name: `${prefix}stop`, 
                            value: 'Stops the music, clears the queue, and disconnects the bot.\n' +
                                  'Example:\n' +
                                  `\`${prefix}stop\``
                        },
                        { 
                            name: `${prefix}help`, 
                            value: 'Shows this help message with all available commands.\n' +
                                  'Example:\n' +
                                  `\`${prefix}help\``
                        }
                    ])
                    .setFooter({ 
                        text: 'You must be in a voice channel to use music commands! Commands are not case sensitive.' 
                    });
                
                await message.channel.send({ embeds: [helpEmbed] });
            } catch (error) {
                console.error('Error sending help message:', error);
                message.channel.send('There was an error displaying the help message.');
            }
            break;
            
        case 'play':
            execute(message, args);
            break;
            
        case 'skip':
            skip(message, serverQueue);
            break;
            
        case 'stop':
            stop(message, serverQueue);
            break;
            
        default:
            message.channel.send(`Unknown command! Use ${prefix}help to see all available commands and examples.`);
            break;
    }
});

async function execute(message, args) {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
        return message.channel.send('You need to be in a voice channel!');
    }

    if (!args.length) {
        return message.channel.send('You need to provide a song URL or name!');
    }

    const serverQueue = queue.get(message.guild.id);

    const permissions = voiceChannel.permissionsFor(message.client.user);
    if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
        return message.channel.send('I need permissions to join and speak in your voice channel!');
    }

    try {
        let songInfo;
        let url = args[0];

        if (!url.startsWith('http')) {
            // Search for the song
            const searchResults = await yts(args.join(' '));
            if (!searchResults.videos.length) {
                return message.channel.send('No search results found!');
            }
            url = searchResults.videos[0].url;
        }

        songInfo = await ytdl.getInfo(url);
        const song = {
            title: songInfo.videoDetails.title,
            url: songInfo.videoDetails.video_url
        };

        if (!serverQueue) {
            const queueConstruct = {
                textChannel: message.channel,
                voiceChannel: voiceChannel,
                connection: null,
                songs: [],
                playing: true,
                player: createAudioPlayer()
            };

            // Add player event listeners when creating the player
            queueConstruct.player.on(AudioPlayerStatus.Playing, () => {
                console.log('Audio player status: Playing');
            });

            queueConstruct.player.on(AudioPlayerStatus.Idle, () => {
                console.log('Audio player status: Idle');
                const queue = queueConstruct.songs;
                queue.shift();
                play_song(message.guild, queue[0]);
            });

            queueConstruct.player.on(AudioPlayerStatus.Buffering, () => {
                console.log('Audio player status: Buffering');
            });

            queueConstruct.player.on(AudioPlayerStatus.AutoPaused, () => {
                console.log('Audio player status: AutoPaused');
            });

            queueConstruct.player.on('error', error => {
                console.error(`Error: ${error.message}`);
            });

            queue.set(message.guild.id, queueConstruct);
            queueConstruct.songs.push(song);

            try {
                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: message.guild.id,
                    adapterCreator: message.guild.voiceAdapterCreator,
                });

                connection.on('stateChange', (oldState, newState) => {
                    console.log(`Connection state changed from ${oldState.status} to ${newState.status}`);
                });

                queueConstruct.connection = connection;
                play_song(message.guild, queueConstruct.songs[0]);
            } catch (err) {
                console.error('Error creating connection:', err);
                queue.delete(message.guild.id);
                return message.channel.send('Error joining voice channel!');
            }
        } else {
            serverQueue.songs.push(song);
            return message.channel.send(`${song.title} has been added to the queue!`);
        }
    } catch (error) {
        console.error(error);
        return message.channel.send('An error occurred while processing the command!');
    }
}

async function play_song(guild, song, retryCount = 0) {
    const MAX_RETRIES = 3;
    
    const serverQueue = queue.get(guild.id);
    if (!song) {
        serverQueue.connection.destroy();
        queue.delete(guild.id);
        return;
    }

    try {
        console.log(`Attempt ${retryCount + 1} to stream:`, song.url);
        
        const stream = ytdl(song.url, {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 25, // 32MB buffer
            dlChunkSize: 0, // Disable chunk size limit
        });
        
        const resource = createAudioResource(stream, {
            inputType: 'webm/opus',
            inlineVolume: true,
            silencePaddingFrames: 5 
        });
        
        if (!resource) {
            throw new Error('Failed to create audio resource');
        }

        resource.volume?.setVolume(0.5); // Maximum volume

        serverQueue.player.play(resource);
        
        const subscription = serverQueue.connection.subscribe(serverQueue.player);
        if (!subscription) {
            throw new Error('Failed to subscribe to the player');
        }

        serverQueue.textChannel.send(`🎵 Now playing: ${song.title}`);

    } catch (error) {
        console.error(`Error in play_song (attempt ${retryCount + 1}):`, error);
        
        if (retryCount < MAX_RETRIES) {
            console.log(`Retrying... (${retryCount + 1}/${MAX_RETRIES})`);
            setTimeout(() => {
                play_song(guild, song, retryCount + 1);
            }, 5000);
        } else {
            console.log('Max retries reached, skipping song...');
            serverQueue.textChannel.send(`❌ Failed to play ${song.title} after multiple attempts, skipping...`);
            serverQueue.songs.shift();
            play_song(guild, serverQueue.songs[0], 0);
        }
    }
}

function skip(message, serverQueue) {
    if (!message.member.voice.channel) {
        return message.channel.send('You need to be in a voice channel!');
    }
    if (!serverQueue) {
        return message.channel.send('There is no song playing!');
    }
    serverQueue.player.stop();
    message.channel.send('Skipped the song!');
}

function stop(message, serverQueue) {
    if (!message.member.voice.channel) {
        return message.channel.send('You need to be in a voice channel!');
    }
    if (!serverQueue) {
        return message.channel.send('There is no song playing!');
    }
    serverQueue.songs = [];
    serverQueue.player.stop();
    serverQueue.connection.destroy();
    queue.delete(message.guild.id);
    message.channel.send('Stopped the music and cleared the queue!');
}

client.login(process.env.DISCORD_BOT_TOKEN); // Use the token from the .env file
