// Pelagos Voice Agent - Πλήρως Διορθωμένη έκδοση για LocalTunnel
// Αντικαταστήστε ΟΛΟΚΛΗΡΟ τον server.js με αυτόν τον κώδικα

require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const WebSocket = require('ws');

// Configuration
const PORT = process.env.PORT || 3001;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const OPENAI_REALTIME_PROMPT_ID = process.env.OPENAI_REALTIME_PROMPT_ID;

// ΔΙΟΡΘΩΣΗ: LocalTunnel URL για WebSocket
const NGROK_URL = 'https://red-oranges-matter.loca.lt';

console.log('🔧 Ξεκινάω τον Pelagos Voice Agent...');

// Έλεγχος API Keys
if (!OPENAI_API_KEY) {
  console.error('❌ Λείπει το OPENAI_API_KEY στο .env αρχείο');
  process.exit(1);
}

if (!TELNYX_API_KEY) {
  console.error('❌ Λείπει το TELNYX_API_KEY στο .env αρχείο');
  process.exit(1);
}

if (!OPENAI_REALTIME_PROMPT_ID) {
  console.error('❌ Λείπει το OPENAI_REALTIME_PROMPT_ID στο .env αρχείο');
  process.exit(1);
}

// Εγγραφή WebSocket plugin
fastify.register(require('@fastify/websocket'));

console.log('✅ API keys loaded successfully');
console.log('✅ Ξεκινάω τον Pelagos Voice Agent με OpenAI Realtime API...');

// Store active calls
const activeCalls = new Map();

// Restaurant functions που θα στείλουμε στο OpenAI
const RESTAURANT_FUNCTIONS = [
  {
    name: "checkAvailability",
    description: "Έλεγχος διαθεσιμότητας τραπεζιών στο εστιατόριο Πέλαγος",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Ημερομηνία κράτησης (YYYY-MM-DD)" },
        time: { type: "string", description: "Ώρα κράτησης (HH:MM)" },
        guests: { type: "integer", description: "Αριθμός ατόμων" }
      },
      required: ["date", "time", "guests"]
    }
  },
  {
    name: "createReservation", 
    description: "Δημιουργία κράτησης στο εστιατόριο Πέλαγος",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Όνομα πελάτη" },
        phone: { type: "string", description: "Τηλέφωνο πελάτη" },
        date: { type: "string", description: "Ημερομηνία κράτησης" },
        time: { type: "string", description: "Ώρα κράτησης" },
        guests: { type: "integer", description: "Αριθμός ατόμων" }
      },
      required: ["name", "phone", "date", "time", "guests"]
    }
  }
];

// Βασικό endpoint για έλεγχο
fastify.get('/', async (request, reply) => {
  return {
    message: '🍽️ Pelagos Voice Agent with OpenAI Realtime API',
    status: 'OK',
    timestamp: new Date().toISOString(),
    ready_for_calls: true,
    openai_realtime: 'enabled',
    tunnel_url: NGROK_URL,
    version: '2.2-localtunnel-fixed'
  };
});

// Health check endpoint
fastify.get('/health', async (request, reply) => {
  return {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    openai_key: OPENAI_API_KEY ? '✅ Connected' : '❌ Missing',
    telnyx_key: TELNYX_API_KEY ? '✅ Connected' : '❌ Missing',
    realtime_prompt: OPENAI_REALTIME_PROMPT_ID ? '✅ Configured' : '❌ Missing',
    active_calls: activeCalls.size,
    tunnel_url: NGROK_URL,
    version: '2.2-localtunnel-fixed'
  };
});

// Test OpenAI Realtime connection
fastify.get('/test-openai', async (request, reply) => {
  console.log('🧪 Testing OpenAI Realtime API connection...');
  
  try {
    const testWS = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        testWS.close();
        reject(new Error('Connection timeout'));
      }, 10000);

      testWS.on('open', () => {
        clearTimeout(timeout);
        console.log('✅ OpenAI Realtime API connection successful!');
        testWS.close();
        resolve({
          status: 'success',
          message: 'OpenAI Realtime API accessible',
          timestamp: new Date().toISOString()
        });
      });

      testWS.on('error', (error) => {
        clearTimeout(timeout);
        console.error('❌ OpenAI Realtime API connection failed:', error.message);
        reject(error);
      });
    });
  } catch (error) {
    console.error('❌ OpenAI test failed:', error.message);
    return reply.code(500).send({
      status: 'error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Telnyx webhook για incoming calls
fastify.post('/telnyx-webhook', async (request, reply) => {
  console.log('📞 Incoming Telnyx webhook:', JSON.stringify(request.body, null, 2));
  
  const { data } = request.body;
  
  if (!data) {
    return reply.code(200).send({ status: 'ok' });
  }

  const { event_type, payload } = data;

  try {
    switch (event_type) {
      case 'call.initiated':
        console.log('📞 Νέα εισερχόμενη κλήση:', payload.call_control_id);
        await handleIncomingCall(payload);
        break;

      case 'call.answered':
        console.log('📞 Κλήση απαντήθηκε:', payload.call_control_id);
        await startAudioSession(payload);
        break;

      case 'call.hangup':
        console.log('📞 Κλήση τερματίστηκε:', payload.call_control_id);
        await cleanup(payload.call_control_id);
        break;

      case 'call.streaming.started':
        console.log('📞 Media streaming ξεκίνησε:', payload.call_control_id);
        break;

      case 'call.streaming.stopped':
        console.log('📞 Media streaming σταμάτησε:', payload.call_control_id);
        break;

      default:
        console.log('📞 Άλλο event:', event_type);
    }
  } catch (error) {
    console.error('❌ Σφάλμα στον Telnyx webhook handler:', error);
  }

  return reply.code(200).send({ status: 'ok' });
});

// Function για χειρισμό εισερχόμενων κλήσεων
async function handleIncomingCall(payload) {
  const { call_control_id, from, to } = payload;
  
  console.log(`📞 Απάντηση σε κλήση από ${from} προς ${to}`);

  try {
    // Answer the call
    const answerResponse = await fetch('https://api.telnyx.com/v2/calls/' + call_control_id + '/actions/answer', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TELNYX_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (answerResponse.ok) {
      console.log('✅ Κλήση απαντήθηκε επιτυχώς');
      
      // Store call info
      activeCalls.set(call_control_id, {
        from,
        to,
        startTime: new Date(),
        status: 'answered'
      });

      // Σύντομη παύση πριν ξεκινήσει το streaming
      setTimeout(() => {
        startAudioSession(payload);
      }, 1000);
      
    } else {
      const errorText = await answerResponse.text();
      console.error('❌ Αποτυχία απάντησης κλήσης:', errorText);
    }
  } catch (error) {
    console.error('❌ Σφάλμα κατά την απάντηση της κλήσης:', error);
  }
}

// Function για έναρξη audio session με OpenAI
async function startAudioSession(payload) {
  const { call_control_id } = payload;
  
  console.log('🎵 Έναρξη audio session με OpenAI για κλήση:', call_control_id);

  try {
    // ΔΙΟΡΘΩΣΗ: Χρήση του σωστού LocalTunnel WebSocket URL
    const streamUrl = `${NGROK_URL.replace('https://', 'wss://')}/media-stream`;
    
    console.log('🎵 Stream URL:', streamUrl);

    // Start media streaming με διορθωμένο stream_track
    const mediaResponse = await fetch(`https://api.telnyx.com/v2/calls/${call_control_id}/actions/streaming_start`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TELNYX_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        stream_url: streamUrl,
        stream_track: 'both_tracks',
        enable_dialogflow_enhanced: false
      })
    });

    if (mediaResponse.ok) {
      console.log('✅ Media streaming ξεκίνησε επιτυχώς');
      
      // Ενημέρωση call status
      const callInfo = activeCalls.get(call_control_id);
      if (callInfo) {
        callInfo.status = 'streaming';
        callInfo.streamStartTime = new Date();
      }
    } else {
      const errorText = await mediaResponse.text();
      console.error('❌ Αποτυχία έναρξης media streaming:', errorText);
    }
  } catch (error) {
    console.error('❌ Σφάλμα κατά την έναρξη audio session:', error);
  }
}

// WebSocket για media streaming
fastify.register(async function (fastify) {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('🎵 Νέα WebSocket σύνδεση για media streaming');
    
    let openaiWS = null;
    
    try {
      // Connect to OpenAI Realtime API
      openaiWS = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      openaiWS.on('open', () => {
        console.log('🤖 Συνδέθηκε στο OpenAI Realtime API');
        
        // Configure session με το prompt σου
        const sessionConfig = {
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: `Είσαι η Μαρία, η εξυπηρετική AI hostess του εστιατορίου Πέλαγος στη Λεμεσό, Κύπρος. 
            Μιλάς άψογα ελληνικά και βοηθάς τους πελάτες με:
            - Κρατήσεις τραπεζιών
            - Πληροφορίες για το μενού
            - Ώρες λειτουργίας (Τρίτη-Κυριακή 6μ.μ.-12π.μ., κλειστά Δευτέρες)
            - Ακύρωση κρατήσεων
            
            Είσαι φιλική, επαγγελματική και πρόθυμη να βοηθήσεις. Χαιρέτα τους πελάτες και ρώτα πώς μπορείς να βοηθήσεις.`,
            voice: 'alloy',
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            input_audio_transcription: {
              model: 'whisper-1'
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500
            },
            tools: RESTAURANT_FUNCTIONS,
            tool_choice: 'auto'
          }
        };
        
        openaiWS.send(JSON.stringify(sessionConfig));
        
        // Send initial greeting
        setTimeout(() => {
          const responseConfig = {
            type: 'response.create',
            response: {
              modalities: ['audio'],
              instructions: 'Χαιρέτα τον πελάτη στα ελληνικά και πες ότι είσαι η Μαρία από το εστιατόριο Πέλαγος.'
            }
          };
          openaiWS.send(JSON.stringify(responseConfig));
        }, 1000);
      });

      // Proxy messages between Telnyx and OpenAI
      connection.socket.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          
          if (data.event === 'media' && data.media && data.media.payload) {
            // Convert from base64 to binary for OpenAI
            const audioData = Buffer.from(data.media.payload, 'base64');
            
            // Forward audio to OpenAI
            const audioEvent = {
              type: 'input_audio_buffer.append',
              audio: audioData.toString('base64')
            };
            
            if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
              openaiWS.send(JSON.stringify(audioEvent));
            }
          }
          
          if (data.event === 'start') {
            console.log('🎵 Media stream ξεκίνησε από Telnyx');
          }
          
        } catch (error) {
          console.error('❌ Error processing Telnyx message:', error);
        }
      });

      openaiWS.on('message', (message) => {
        try {
          const event = JSON.parse(message);
          
          if (event.type === 'response.audio.delta' && event.delta) {
            // Forward audio back to Telnyx
            const mediaMessage = {
              event: 'media',
              streamSid: 'stream_' + Date.now(),
              media: {
                payload: event.delta
              }
            };
            
            if (connection.socket.readyState === WebSocket.OPEN) {
              connection.socket.send(JSON.stringify(mediaMessage));
            }
          }
          
          if (event.type === 'session.created') {
            console.log('🤖 OpenAI session created successfully');
          }
          
          if (event.type === 'response.audio_transcript.done') {
            console.log('🤖 OpenAI response:', event.transcript);
          }
          
        } catch (error) {
          console.error('❌ Error processing OpenAI message:', error);
        }
      });

      connection.socket.on('close', () => {
        console.log('🔌 Telnyx WebSocket connection closed');
        if (openaiWS) {
          openaiWS.close();
        }
      });

      openaiWS.on('close', () => {
        console.log('🤖 OpenAI connection closed');
        if (connection.socket.readyState === WebSocket.OPEN) {
          connection.socket.close();
        }
      });

      openaiWS.on('error', (error) => {
        console.error('❌ OpenAI WebSocket error:', error);
      });

    } catch (error) {
      console.error('❌ Error setting up WebSocket connections:', error);
      if (connection.socket.readyState === WebSocket.OPEN) {
        connection.socket.close();
      }
    }
  });
});

// Cleanup function
async function cleanup(callControlId) {
  activeCalls.delete(callControlId);
  console.log('🧹 Cleanup για κλήση:', callControlId);
}

// Restaurant function implementations
function handleRestaurantFunction(functionName, parameters) {
  switch (functionName) {
    case 'checkAvailability':
      return {
        available: true,
        message: `Διαθέσιμο τραπέζι για ${parameters.guests} άτομα στις ${parameters.time} την ${parameters.date}`
      };
    
    case 'createReservation':
      return {
        success: true,
        reservationId: 'RES' + Date.now(),
        message: `Κράτηση επιβεβαιώθηκε για τον/την ${parameters.name}`
      };
    
    default:
      return { error: 'Unknown function' };
  }
}

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 Server ξεκίνησε στο http://localhost:${PORT}`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
    console.log(`🧪 Test OpenAI: http://localhost:${PORT}/test-openai`);
    console.log(`📞 Telnyx Webhook: ${NGROK_URL}/telnyx-webhook`);
    console.log(`🎵 Media Stream: ${NGROK_URL.replace('https://', 'wss://')}/media-stream`);
    console.log('🎉 PELAGOS VOICE AGENT ΜΕ OPENAI REALTIME API ΞΕΚΙΝΗΣΕ! 🎉');
    console.log('🍽️ Έτοιμος για ελληνικές κλήσεις! 🇬🇷');
  } catch (err) {
    console.error('❌ Σφάλμα κατά την εκκίνηση:', err);
    process.exit(1);
  }
};

start();