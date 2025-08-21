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
      // Answer the call
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
    
    // Start media streaming
    setTimeout(async () => {
      console.log('🎵 Έναρξη audio session με OpenAI για κλήση:', data.payload.call_control_id);
      const streamUrl = `wss://${request.headers.host}/media-stream`;
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
  // ✅ ΤΑ ΚΡΙΣΙΜΑ ΠΕΔΙΑ ΠΟΥ ΛΕΙΠΟΥΝ:
  stream_bidirectional_mode: "rtp",
  stream_bidirectional_codec: "PCMU", 
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

// Audio conversion helpers
function mulawToPCM16(mu) {
  const out = Buffer.alloc(mu.length * 2);
  for (let i = 0; i < mu.length; i++) {
    let u = ~mu[i] & 0xFF;
    let sign = (u & 0x80) ? -1 : 1;
    let exponent = (u >> 4) & 0x07;
    let mantissa = u & 0x0F;
    let magnitude = ((mantissa << 1) + 1) << (exponent + 2);
    let sample = sign * (magnitude - 33);
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

function resampleLinearPCM16(input, inRate, outRate) {
  if (inRate === outRate) return input;
  const inSamples = input.length / 2;
  const outSamples = Math.round(inSamples * outRate / inRate);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const t = i * (inSamples - 1) / (outSamples - 1);
    const i0 = Math.floor(t), i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = t - i0;
    const s0 = input.readInt16LE(i0 * 2);
    const s1 = input.readInt16LE(i1 * 2);
    const s = (1 - frac) * s0 + frac * s1;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, s | 0)), i * 2);
  }
  return out;
}

// CORRECT WebSocket handler with audio conversion
fastify.get('/media-stream', { websocket: true }, (socket, req) => {
  console.log('🎵 Νέα WebSocket σύνδεση για media streaming');
  console.log('🌐 Connection from:', req.ip || req.hostname || 'unknown');


  // 1) Attach listeners SYNCHRONOUSLY
  socket.on('message', onTelnyxMessage);
  socket.on('close', () => cleanup('telnyx closed'));
  socket.on('error', (e) => console.error('❌ Telnyx WS error', e));

  // 2) Keepalive to avoid idle drops
  const ping = setInterval(() => { 
    try { 
      socket.ping(); 
    } catch (e) {
      console.log('Ping failed:', e.message);
    }
  }, 25000);

  // 3) Connect to OpenAI Realtime
  const oai = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
    { 
      headers: { 
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1' 
      } 
    }
  );

  oai.on('open', () => {
    console.log('🤖 Συνδέθηκε στο OpenAI Realtime API');
    
    // Configure session
    oai.send(JSON.stringify({
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' },
        input_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        output_audio_format: 'g711_ulaw',
        modalities: ['audio', 'text'],
        voice: 'alloy',
        instructions: `Είσαι η Μαρία, η AI hostess του εστιατορίου Πέλαγος στη Λεμεσό. 
        Μιλάς μόνο ελληνικά με φιλικό και επαγγελματικό τρόπο. 
        Βοηθάς με κρατήσεις τραπεζιών και πληροφορίες για το εστιατόριο.
        Χαιρέτα τους πελάτες και ρώτα πώς μπορείς να τους βοηθήσεις.`
      }
    }));
  });

  // OpenAI → Telnyx (audio out)  
  let outBuffer = Buffer.alloc(0);
  oai.on('message', (buf) => {
    try {
      const message = JSON.parse(buf.toString());
      
      if (message.type === 'response.audio.delta' && message.delta) {
        // message.delta is base64 g711_ulaw
        outBuffer = Buffer.concat([outBuffer, Buffer.from(message.delta, 'base64')]);
        
        // Send back to Telnyx in 20ms chunks (160 bytes for PCMU @ 8kHz)
        while (outBuffer.length >= 160) {
          const frame = outBuffer.subarray(0, 160);
          outBuffer = outBuffer.subarray(160);
          
          if (socket.readyState === 1) { // WebSocket.OPEN
            socket.send(JSON.stringify({ 
              event: 'media', 
              media: { 
                payload: frame.toString('base64') 
              } 
            }));
          }
        }
      }
      
      if (message.type === 'session.created') {
        console.log('✅ OpenAI session created');
      } else if (message.type === 'response.created') {
        console.log('💬 OpenAI response started');
      } else if (message.type === 'response.done') {
        console.log('✅ OpenAI response completed');
      }
      
    } catch (error) {
      console.error('❌ Error processing OpenAI message:', error);
    }
  });

  oai.on('close', () => cleanup('oai closed'));
  oai.on('error', (e) => console.error('❌ OpenAI WS error', e));

  function cleanup(reason) {
    clearInterval(ping);
    try { socket.terminate(); } catch (e) {}
    try { oai.terminate(); } catch (e) {}
    console.log('🧹 Cleanup:', reason);
  }

  // Telnyx → OpenAI (audio in)
  function onTelnyxMessage(data) {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.event === 'start') {
        console.log('🎬 Telnyx media stream started');
        console.log('📋 Media format:', msg.start?.media_format);
        
      } else if (msg.event === 'media' && msg.media?.payload) {
        // Convert μ-law @ 8kHz → PCM16 @ 24kHz for OpenAI
        const rtpPayload = Buffer.from(msg.media.payload, 'base64'); // μ-law @ 8kHz
        const pcm16_8k = mulawToPCM16(rtpPayload);                    // decode μ-law → PCM16
        const pcm16_24k = resampleLinearPCM16(pcm16_8k, 8000, 24000); // 8k → 24k
        
        if (oai.readyState === 1) { // WebSocket.OPEN
          oai.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: pcm16_24k.toString('base64')
          }));
        }
        
      } else if (msg.event === 'stop') {
        console.log('🛑 Telnyx media stream stopped');
      }
      
    } catch (error) {
      console.error('❌ Error processing Telnyx message:', error);
    }
  }
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
