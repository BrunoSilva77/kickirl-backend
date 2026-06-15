import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ScrollView, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import * as Location from 'expo-location';
import { useKeepAwake } from 'expo-keep-awake';

export default function App() {
  useKeepAwake(); // Keep screen on

  const SERVER_URL = 'https://kickirl-backend.onrender.com';
  const [username, setUsername] = useState('');
  const [pushKey, setPushKey] = useState(null);
  
  const [isTracking, setIsTracking] = useState(false);
  const [locationSub, setLocationSub] = useState(null);
  const [statusText, setStatusText] = useState('Aguardando...');
  const [logs, setLogs] = useState([]);

  const addLog = (msg) => {
    setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 15));
  };

  const handleConnect = async () => {
    if (!username.trim() || !SERVER_URL.trim()) return Alert.alert('Erro', 'Preencha Servidor e Nickname');
    
    try {
      addLog('Conectando ao servidor...');
      const url = SERVER_URL.endsWith('/') ? SERVER_URL.slice(0, -1) : SERVER_URL;
      const res = await fetch(`${url}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim() })
      });
      const data = await res.json();
      
      if (data.pushKey) {
        setPushKey(data.pushKey);
        addLog('Conectado com sucesso! PushKey recebida.');
      } else {
        addLog('Erro ao conectar: ' + data.error);
      }
    } catch (e) {
      addLog('Erro de rede: ' + e.message);
      Alert.alert('Erro', 'Não foi possível conectar ao servidor. Verifique o IP do seu computador na rede Wi-Fi.');
    }
  };

  const startTracking = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permissão negada', 'O app precisa do GPS para funcionar.');
      return;
    }

    addLog('Iniciando rastreamento GPS...');
    setIsTracking(true);
    setStatusText('Buscando satélites...');

    const sub = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 3000,
        distanceInterval: 1,
      },
      async (loc) => {
        const { latitude, longitude, accuracy, speed, heading } = loc.coords;
        setStatusText(`Enviando (Precisão: ${Math.round(accuracy)}m)`);
        
        try {
          const url = SERVER_URL.endsWith('/') ? SERVER_URL.slice(0, -1) : SERVER_URL;
          await fetch(`${url}/api/push?key=${pushKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat: latitude, lon: longitude, accuracy, speed, heading })
          });
          addLog(`GPS: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
        } catch (e) {
          addLog('Erro ao enviar GPS (Rede)');
        }
      }
    );
    setLocationSub(sub);
  };

  const stopTracking = async () => {
    if (locationSub) {
      locationSub.remove();
      setLocationSub(null);
    }
    setIsTracking(false);
    setStatusText('Rastreamento parado.');
    addLog('GPS Desativado.');

    try {
      const url = SERVER_URL.endsWith('/') ? SERVER_URL.slice(0, -1) : SERVER_URL;
      await fetch(`${url}/api/stop?key=${pushKey}`, { method: 'POST' });
    } catch (e) {
      // Ignora erro de rede no stop
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.container}>
      <Text style={styles.title}>Kick<Text style={styles.titleHighlight}>IRL</Text> Mobile</Text>
      
      {!pushKey ? (
        <View style={styles.card}>

          <Text style={styles.label}>Seu canal na Kick</Text>
          <TextInput 
            style={styles.input} 
            value={username} 
            onChangeText={setUsername} 
            placeholder="Ex: ninja" 
            placeholderTextColor="#666"
            autoCapitalize="none"
          />
          
          <TouchableOpacity style={styles.btn} onPress={handleConnect}>
            <Text style={styles.btnText}>Conectar Aparelho</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.label}>Rastreamento Ativo</Text>
          
          <TouchableOpacity 
            style={[styles.btn, isTracking && styles.btnStop]} 
            onPress={isTracking ? stopTracking : startTracking}
          >
            <Text style={styles.btnText}>{isTracking ? 'Parar GPS' : 'Iniciar GPS'}</Text>
          </TouchableOpacity>
          
          {isTracking && (
            <View style={styles.statusBox}>
              <View style={styles.statusDot} />
              <Text style={styles.statusText}>{statusText}</Text>
            </View>
          )}
        </View>
      )}

      <ScrollView style={styles.logs}>
        {logs.map((l, i) => <Text key={i} style={styles.logText}>{l}</Text>)}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0b0b',
    alignItems: 'center',
    padding: 24,
    paddingTop: 60,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: '#fff',
    marginBottom: 32,
  },
  titleHighlight: {
    color: '#53FC18',
  },
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#151515',
    padding: 24,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#222',
  },
  label: {
    color: '#ccc',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
    marginTop: 12,
  },
  input: {
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: '#333',
    color: '#fff',
    padding: 14,
    borderRadius: 10,
    fontSize: 16,
    marginBottom: 8,
  },
  btn: {
    backgroundColor: '#53FC18',
    padding: 16,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 16,
  },
  btnStop: {
    backgroundColor: '#ef4444',
  },
  btnText: {
    color: '#000',
    fontWeight: '800',
    fontSize: 16,
  },
  statusBox: {
    marginTop: 20,
    padding: 16,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#53FC18',
    marginRight: 8,
  },
  statusText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  logs: {
    width: '100%',
    maxWidth: 400,
    marginTop: 24,
    backgroundColor: '#000',
    borderRadius: 8,
    padding: 12,
    maxHeight: 150,
  },
  logText: {
    color: '#888',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: 4,
  }
});
