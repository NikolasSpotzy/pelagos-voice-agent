require('dotenv').config();
const Fastify = require('fastify');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';

const fastify = Fastify({ 
  logger: true,
  trustProxy: true 
});

// Register WebSocket support
fastify.register(require('@fastify/websocket'));

// CORS and basic routes
fastify.addHook('onRequest', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');
});

fastify.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

fastify.get('/', async (request, reply) => {
  return { 
    message: 'Spotzy AI Voice Agent Server',
    status: 'running',
    environment: 'Render',
    timestamp: new Date().toISOString()
  };
});

// Telnyx webhook endpoint
fastify.post('/telnyx-webhook', async (request, reply) => {
  const { data } = request.body;
  
  console.log('📞 Incoming Telnyx webhook:', JSON.stringify(data, null, 2));
  
  if (data.event_type === 'call.initiated') {
    console.log('📞 Νέα εισερχόμενη κλήση:', data.payload.call_control_id);
    console.log('📞 Απάντηση σε κλήση από', data.payload.from, 'προς', data.payload.to);
    
    try {
      const response = await fetch(`https://api.telnyx.com/v2/calls/${data.payload.call_control_id}/actions/answer`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (response.ok) {
        console.log('✅ Κλήση απαντήθηκε επιτυχώς');
      }
    } catch (error) {
      console.error('❌ Error answering call:', error);
    }
    
  } else if (data.event_type === 'call.answered') {
    console.log('📞 Κλήση απαντήθηκε:', data.payload.call_control_id);
    
    setTimeout(async () => {
      console.log('🎵 Έναρξη audio session με OpenAI για κλήση:', data.payload.call_control_id);
      const streamUrl = `wss://pelagos-voice-agent.onrender.com/media-stream`;
      console.log('🎵 Stream URL:', streamUrl);
      
      try {
        const streamResponse = await fetch(`https://api.telnyx.com/v2/calls/${data.payload.call_control_id}/actions/streaming_start`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            stream_url: streamUrl,
            stream_track: 'both_tracks',
            stream_bidirectional_mode: "rtp",
            stream_bidirectional_codec: "PCMA",
            stream_bidirectional_target_legs: "opposite"
          })
        });
        
        if (streamResponse.ok) {
          console.log('✅ Media streaming ξεκίνησε επιτυχώς');
        } else {
          console.error('❌ Failed to start streaming:', await streamResponse.text());
        }
      } catch (error) {
        console.error('❌ Error starting stream:', error);
      }
    }, 1000);
    
  } else if (data.event_type === 'streaming.failed') {
    console.log('❌ Media streaming απέτυχε:', data.payload.call_control_id);
    console.log('❌ Failure reason:', data.payload.failure_reason);
  } else if (data.event_type === 'call.hangup') {
    console.log('📞 Κλήση τερματίστηκε:', data.payload.call_control_id);
  } else {
    console.log('📞 Άλλο event:', data.event_type);
  }
  
  reply.send({ received: true });
});

// WebSocket endpoint
fastify.register(async function (fastify) {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    const socket = connection;
    console.log('🎵 Νέα WebSocket σύνδεση για media streaming');
    console.log('🌐 Connection from:', req.ip || req.hostname || 'unknown');

    let openaiWs = null;
    let streamSid = null;
    let latestMediaTimestamp = 0;

    function handleTelnyxMessage(data) {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.event === 'start') {
          console.log('🎬 Telnyx media stream started');
          console.log('📋 Media format:', msg.start?.media_format);
          streamSid = msg.start?.stream_sid || 'telnyx-stream';
          latestMediaTimestamp = 0;
          connectToOpenAI();
          
        } else if (msg.event === 'media' && msg.media?.payload) {
          latestMediaTimestamp = msg.media.timestamp || Date.now();
          
          if (openaiWs && openaiWs.readyState === 1) {
            openaiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: msg.media.payload
            }));
          }
          
        } else if (msg.event === 'stop') {
          console.log('🛑 Telnyx media stream stopped');
          cleanup();
        }
        
      } catch (error) {
        console.error('❌ Error processing Telnyx message:', error);
      }
    }

    function connectToOpenAI() {
      openaiWs = new WebSocket(
        'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1'
          }
        }
      );

      openaiWs.on('open', () => {
        console.log('🤖 Συνδέθηκε στο OpenAI Realtime API');
        
        openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            turn_detection: null,
            voice: 'alloy',
            input_audio_transcription: { model: 'whisper-1' },
            input_audio_format: 'g711_alaw',
            output_audio_format: 'g711_alaw',
            instructions: `Είσαι η Μαρία, η AI hostess του εστιατορίου Πέλαγος στη Λεμεσό. 
            Μιλάς μόνο ελληνικά με φιλικό και επαγγελματικό τρόπο. 
            Βοηθάς με κρατήσεις τραπεζιών και πληροφορίες για το εστιατόριο.
            Χαιρέτα τους καλούντες και ρώτα πώς μπορείς να τους βοηθήσεις.`
          }
        }));
        
        // Manual response trigger after 2 seconds
        setTimeout(() => {
          if (openaiWs && openaiWs.readyState === 1) {
            console.log('🎤 Manual response trigger');
            openaiWs.send(JSON.stringify({
              type: 'response.create',
              response: {
                modalities: ['audio'],
                instructions: 'Πες: "Γεια σας, είμαι η Μαρία από το εστιατόριο Πέλαγος. Πώς μπορώ να σας βοηθήσω;"'
              }
            }));
          }
        }, 2000);
      });

      openaiWs.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          
          if (event.type === 'session.created') {
            console.log('✅ OpenAI session created');
          } else if (event.type === 'response.audio.delta') {
            console.log('💬 OpenAI audio response delta');
            
            if (socket.readyState === 1 && streamSid) {
              socket.send(JSON.stringify({
                event: 'media',
                streamSid: streamSid,
                media: { 
                  payload: event.delta
                }
              }));
            }
          } else if (event.type === 'response.created') {
            console.log('💬 OpenAI response started');
          } else if (event.type === 'response.done') {
            console.log('✅ OpenAI response completed');
          }
          
        } catch (error) {
          console.error('❌ Error processing OpenAI message:', error);
        }
      });

      openaiWs.on('error', (error) => {
        console.error('❌ OpenAI WS error:', error);
        cleanup();
      });

      openaiWs.on('close', () => {
        console.log('🔌 OpenAI connection closed');
        cleanup();
      });
    }

    function cleanup() {
      if (openaiWs) {
        try { openaiWs.close(); } catch (e) {}
        openaiWs = null;
      }
      streamSid = null;
      latestMediaTimestamp = 0;
      console.log('🧹 Cleanup completed');
    }

    socket.on('message', handleTelnyxMessage);
    socket.on('close', () => {
      console.log('🔌 Telnyx WebSocket closed');
      cleanup();
    });
    socket.on('error', (error) => {
      console.error('❌ Telnyx WS error:', error);
      cleanup();
    });
  });
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`🚀 Spotzy AI Voice Agent running on ${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
