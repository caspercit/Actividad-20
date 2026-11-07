import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, Image, KeyboardAvoidingView, Platform,
  Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { decode } from 'base64-arraybuffer';
import { StatusBar } from 'expo-status-bar';
import { supabase } from './src/supabase';

const BUCKET = 'incidencias';
const MAX_BYTES = 5 * 1024 * 1024;
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function Button({ title, onPress, disabled, secondary = false }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={[styles.button, secondary && styles.secondary, disabled && styles.disabled]}>
      <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{title}</Text>
    </Pressable>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState([]);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let alive = true;
    async function initialize() {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        let current = data.session?.user;
        if (!current) {
          const res = await supabase.auth.signInAnonymously();
          if (res.error) throw res.error;
          current = res.data.user;
        }
        if (alive) setUser(current);
      } catch (e) {
        if (alive) Alert.alert('Error de acceso', `${e.message}\nVerifica .env y habilita Anonymous Sign-Ins en Supabase.`);
      } finally { if (alive) setLoading(false); }
    }
    initialize();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (user) loadItems();
  }, [user?.id]);

  async function loadItems() {
    try {
      const { data, error } = await supabase.from('incidencias')
        .select('id,titulo,descripcion,foto_path,created_at')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const withUrls = await Promise.all((data || []).map(async (item) => {
        const { data: signed, error: urlError } = await supabase.storage.from(BUCKET)
          .createSignedUrl(item.foto_path, 300);
        return { ...item, photoUrl: urlError ? null : signed?.signedUrl };
      }));
      setItems(withUrls);
      setMessage(`${withUrls.length} incidencia(s) recuperada(s) desde la nube.`);
    } catch (e) { setMessage(`No fue posible consultar: ${e.message}`); }
  }

  function validateImage(asset) {
    // Comprobación en cliente para una mejor UX; el bucket vuelve a validar tamaño y MIME.
    let mime = (asset.mimeType || '').toLowerCase();
    if (!mime) {
      const ext = (asset.fileName || asset.uri || '').split('.').pop().toLowerCase().split('?')[0];
      mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : '';
    }
    if (!MIME_EXT[mime]) throw new Error('Formato inválido. Solo JPG, PNG o WEBP.');
    if (asset.fileSize && asset.fileSize > MAX_BYTES) throw new Error('La fotografía supera los 5 MB permitidos.');
    return { ...asset, mime };
  }

  async function choose(fromCamera) {
    try {
      if (fromCamera) {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) throw new Error('Permiso de cámara denegado.');
      }
      const result = fromCamera
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      if (!result.canceled && result.assets?.[0]) {
        const image = validateImage(result.assets[0]);
        setSelected(image);
        setMessage('Fotografía seleccionada y lista para cargar.');
      }
    } catch (e) { Alert.alert('Fotografía no válida', e.message); }
  }

  async function register() {
    if (busy) return;
    if (!user) return Alert.alert('Sin sesión', 'Revisa la conexión con Supabase.');
    if (title.trim().length < 3 || description.trim().length < 5) {
      return Alert.alert('Datos incompletos', 'Título mínimo 3 caracteres y descripción mínimo 5.');
    }
    if (title.trim().length > 100 || description.trim().length > 1000) {
      return Alert.alert('Texto demasiado largo', 'Título máximo 100, descripción máximo 1000 caracteres.');
    }
    if (!selected) return Alert.alert('Falta fotografía', 'Selecciona o toma una fotografía.');
    setBusy(true);
    setMessage('Cargando fotografía de forma segura...');
    try {
      const image = validateImage(selected);
      const info = await FileSystem.getInfoAsync(image.uri, { size: true });
      if (!info.exists) throw new Error('La fotografía ya no está disponible en el dispositivo.');
      if (info.size && info.size > MAX_BYTES) throw new Error('La fotografía supera los 5 MB.');
      const base64 = await FileSystem.readAsStringAsync(image.uri, { encoding: FileSystem.EncodingType.Base64 });
      const buffer = decode(base64);
      if (buffer.byteLength > MAX_BYTES) throw new Error('La fotografía supera los 5 MB.');
      const extension = MIME_EXT[image.mime];
      const path = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extension}`;
      const { error: uploadError } = await supabase.storage.from(BUCKET)
        .upload(path, buffer, { contentType: image.mime, cacheControl: '3600', upsert: false });
      if (uploadError) throw uploadError;
      const { error: insertError } = await supabase.from('incidencias').insert({
        usuario_id: user.id, titulo: title.trim(), descripcion: description.trim(), foto_path: path,
      });
      if (insertError) {
        throw new Error(`Foto subida, pero no se registró la incidencia: ${insertError.message}. Ruta: ${path}. Contacta al administrador para limpiar el archivo.`);
      }
      setTitle(''); setDescription(''); setSelected(null);
      await loadItems();
      Alert.alert('Carga exitosa', 'Incidencia registrada. Fotografía guardada en almacenamiento privado.');
      setMessage('Transferencia exitosa; archivo y metadatos almacenados.');
    } catch (e) {
      setMessage(`Error de transferencia: ${e.message}`);
      Alert.alert('No se pudo registrar', e.message);
    } finally { setBusy(false); }
  }

  if (loading) return <View style={styles.center}><ActivityIndicator size="large" /><Text>Preparando acceso seguro...</Text></View>;
  return (
    <SafeAreaView style={styles.page}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <Text style={styles.heading}>Incidencias Cloud</Text>
          <Text style={styles.subtitle}>Actividad 20 · Fotografías protegidas en Supabase Storage</Text>
          <Text style={styles.identity}>{user ? `Sesión autenticada · ${user.id.slice(0, 8)}…` : 'No hay sesión. Configura Supabase.'}</Text>
          <Text style={styles.section}>Nueva incidencia</Text>
          <TextInput placeholder="Título de la incidencia" value={title} onChangeText={setTitle} maxLength={100} style={styles.input} />
          <TextInput placeholder="Describe el problema observado" multiline value={description} onChangeText={setDescription} maxLength={1000} style={[styles.input, styles.multiline]} />
          <View style={styles.actions}>
            <View style={styles.actionItem}><Button title="Galería" secondary onPress={() => choose(false)} disabled={busy} /></View>
            <View style={styles.actionItem}><Button title="Cámara" secondary onPress={() => choose(true)} disabled={busy} /></View>
          </View>
          {selected ? <><Text style={styles.caption}>Vista previa (archivo local)</Text><Image source={{ uri: selected.uri }} style={styles.preview} /><Text style={styles.caption}>{selected.mime} · {selected.fileSize ? `${(selected.fileSize / 1024 / 1024).toFixed(2)} MB` : 'Tamaño no disponible'}</Text></> : <Text style={styles.hint}>Selecciona una fotografía JPG, PNG o WEBP (máximo 5 MB).</Text>}
          <Button title={busy ? 'Enviando archivo...' : 'Registrar y subir fotografía'} onPress={register} disabled={busy || !user} />
          <Text style={styles.feedback}>{message}</Text>
          <View style={styles.listHeading}><Text style={styles.section}>Incidencias guardadas</Text></View>
          <Button title="Actualizar desde la nube" onPress={loadItems} disabled={!user || busy} secondary />
          {items.length === 0 ? <Text style={styles.hint}>No hay incidencias registradas en esta cuenta.</Text> : items.map(item => (
            <View key={item.id} style={styles.card}>
              <Text style={styles.cardTitle}>{item.titulo}</Text>
              <Text style={styles.body}>{item.descripcion}</Text>
              <Text style={styles.caption}>{new Date(item.created_at).toLocaleString()}</Text>
              {item.photoUrl ? <Image source={{ uri: item.photoUrl }} style={styles.savedImage} /> : <Text style={styles.error}>No se pudo generar el enlace temporal.</Text>}
              <Text style={styles.path} selectable>Ruta privada: {item.foto_path}</Text>
            </View>
          ))}
          <Text style={styles.footer}>Las URLs de visualización son temporales (5 minutos). Al actualizar se generan de nuevo. El bucket no es público.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f4f7fb' }, center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  container: { padding: 20, paddingBottom: 46 }, heading: { color: '#182c4b', fontSize: 27, fontWeight: '800', marginTop: 15 },
  subtitle: { color: '#5b6b81', marginTop: 6, lineHeight: 19 }, identity: { color: '#446487', marginTop: 15, fontSize: 12 },
  section: { fontSize: 19, fontWeight: '700', color: '#203650', marginTop: 24, marginBottom: 12 },
  input: { borderWidth: 1, borderColor: '#d4dfea', backgroundColor: '#fff', padding: 13, borderRadius: 10, marginBottom: 12, color: '#1e293b' },
  multiline: { minHeight: 95, textAlignVertical: 'top' }, actions: { flexDirection: 'row', gap: 10 }, actionItem: { flex: 1 },
  button: { borderRadius: 10, padding: 13, backgroundColor: '#2258a6', alignItems: 'center', marginTop: 8 },
  secondary: { backgroundColor: '#e8effa', borderWidth: 1, borderColor: '#cbdcf3' }, disabled: { opacity: .5 },
  buttonText: { color: '#fff', fontWeight: '700', textAlign: 'center' }, secondaryText: { color: '#2458a3' },
  preview: { height: 200, borderRadius: 11, marginTop: 8, backgroundColor: '#e2e8f0' },
  savedImage: { height: 210, borderRadius: 9, marginTop: 12, backgroundColor: '#e2e8f0' },
  caption: { color: '#64748b', fontSize: 12, marginTop: 7 }, hint: { color: '#6b7280', marginVertical: 12 },
  feedback: { color: '#315f7b', fontSize: 13, lineHeight: 19, marginTop: 12 }, listHeading: { marginTop: 6 },
  card: { padding: 16, backgroundColor: '#fff', borderRadius: 13, marginTop: 15, borderWidth: 1, borderColor: '#dce6f0' },
  cardTitle: { fontSize: 17, fontWeight: '700', color: '#152d4e' }, body: { color: '#475569', marginTop: 6, lineHeight: 20 },
  path: { color: '#64748b', fontSize: 10, marginTop: 10 }, error: { color: '#b91c1c', marginTop: 8 },
  footer: { fontSize: 12, lineHeight: 18, color: '#64748b', marginTop: 22 },
});
