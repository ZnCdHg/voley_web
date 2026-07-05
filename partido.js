// ============================================================
// PARTIDO — toda la lógica del juego, SIN tocar la pantalla.
// Es el equivalente a models/partido.dart de la app Flutter.
// Separar lógica y pantalla permite probar la lógica sola:
// test.html carga únicamente este archivo.
// ============================================================

// ----- Reglas de cada modalidad (las tuyas de árbitro) -----
const MODALIDADES = {
  '4v4':   { setsParaGanar: 2, puntosSet: 25, puntosDecisivo: 15, cambioCada: null, cambioDecisivoA: 8, tiemposMuertos: 2 },
  '6v6':   { setsParaGanar: 3, puntosSet: 25, puntosDecisivo: 15, cambioCada: null, cambioDecisivoA: 8, tiemposMuertos: 2 },
  'playa': { setsParaGanar: 2, puntosSet: 21, puntosDecisivo: 15, cambioCada: 7,    cambioDecisivoCada: 5, tiemposMuertos: 2 },
};

// La pantalla "se suscribe" a los avisos sustituyendo esta función
// (app.js hace: alAvisar = mostrarAviso). Así la lógica no necesita
// saber nada del HTML — en los tests simplemente no avisa nadie.
let alAvisar = function (texto) {};

function nuevoPartido(modalidad, nombreLocal, nombreVisitante, colorLocal, colorVisitante) {
  const reglas = MODALIDADES[modalidad];
  return {
    modalidad: modalidad,
    reglas: reglas,
    nombres: [nombreLocal, nombreVisitante],   // índice 0 = local, 1 = visitante
    colores: [colorLocal || '#2f81f7', colorVisitante || '#e5534b'],
    puntos: [0, 0],           // puntos del set en curso
    sets: [0, 0],             // sets ganados
    setsCerrados: [],         // resultados de sets terminados, ej. "25-20"
    eventosPorSet: [],        // por cada set cerrado: quién anotó cada punto [0,1,0,0...]
    eventosSetActual: [],     // ídem del set en curso (para la tira en vivo)
    rachaActual: [0, 0],      // puntos seguidos AHORA MISMO
    rachaMax: [0, 0],         // mejor racha del partido (no baja al restar)
    tmRestantes: [reglas.tiemposMuertos, reglas.tiemposMuertos],  // se reponen cada set
    ladosInvertidos: false,
    yaHuboCambioDecisivo: false,
    terminado: false,
    guardado: false,          // para no guardarlo dos veces en el historial
    inicioMs: Date.now(),     // milisegundos desde 1970: para calcular la duración
    finMs: null,
  };
}

// ============================================================
// LÓGICA DE JUEGO
// Todas reciben "p" (el partido): la lógica no usa variables
// globales, con lo que los tests pueden crear los suyos.
// ============================================================

function esSetDecisivo(p) {
  return p.sets[0] === p.reglas.setsParaGanar - 1 &&
         p.sets[1] === p.reglas.setsParaGanar - 1;
}

function puntosObjetivo(p) {
  return esSetDecisivo(p) ? p.reglas.puntosDecisivo : p.reglas.puntosSet;
}

function sumarPunto(p, equipo) {          // equipo: 0 (local) o 1 (visitante)
  if (p.terminado) return;

  p.puntos[equipo] += 1;
  p.eventosSetActual.push(equipo);        // apuntamos quién hizo este punto

  // Rachas: la del que anota crece, la del rival se corta.
  // "1 - equipo" es un truco: si equipo es 0 da 1, y si es 1 da 0.
  p.rachaActual[equipo] += 1;
  p.rachaActual[1 - equipo] = 0;
  if (p.rachaActual[equipo] > p.rachaMax[equipo]) {
    p.rachaMax[equipo] = p.rachaActual[equipo];
  }

  // El orden importa: si el set termina, ya no hay cambio de campo.
  if (comprobarFinDeSet(p)) return;
  comprobarCambioDeCampo(p);
}

function restarPunto(p, equipo) {
  if (p.terminado) return;
  if (p.puntos[equipo] === 0) return;

  const sumaPrevia = p.puntos[0] + p.puntos[1];
  p.puntos[equipo] -= 1;

  // Quitamos de los eventos el ÚLTIMO punto de ese equipo
  // (igual que el −1 de la app Flutter: el orden queda aproximado).
  const i = p.eventosSetActual.lastIndexOf(equipo);
  if (i !== -1) p.eventosSetActual.splice(i, 1);

  resincronizarRacha(p);                       // la racha máx histórica no se toca
  deshacerCambioCampoSiProcede(p, sumaPrevia); // el bug que arreglamos en Flutter
}

// Recalcula la racha EN CURSO mirando el final de la lista de eventos.
function resincronizarRacha(p) {
  const ev = p.eventosSetActual;
  if (ev.length === 0) {
    p.rachaActual = [0, 0];
    return;
  }
  const ultimo = ev[ev.length - 1];
  let n = 0;
  for (let i = ev.length - 1; i >= 0 && ev[i] === ultimo; i--) n++;
  p.rachaActual[ultimo] = n;
  p.rachaActual[1 - ultimo] = 0;
}

function comprobarFinDeSet(p) {
  const objetivo = puntosObjetivo(p);
  const [pL, pV] = p.puntos;

  // Un set se gana llegando al objetivo CON 2 de diferencia
  let ganador = null;
  if (pL >= objetivo && pL - pV >= 2) ganador = 0;
  if (pV >= objetivo && pV - pL >= 2) ganador = 1;
  if (ganador === null) return false;

  p.sets[ganador] += 1;
  p.setsCerrados.push(pL + '-' + pV);
  p.eventosPorSet.push(p.eventosSetActual);  // archivamos los eventos del set
  p.eventosSetActual = [];

  if (p.sets[ganador] === p.reglas.setsParaGanar) {
    p.terminado = true;
    p.finMs = Date.now();
  } else {
    p.puntos = [0, 0];
    p.rachaActual = [0, 0];
    p.tmRestantes = [p.reglas.tiemposMuertos, p.reglas.tiemposMuertos];
    p.yaHuboCambioDecisivo = false;
    alAvisar('Set para ' + p.nombres[ganador]);
  }
  return true;
}

function comprobarCambioDeCampo(p) {
  const suma = p.puntos[0] + p.puntos[1];
  const decisivo = esSetDecisivo(p);

  if (p.modalidad === 'playa') {
    // Playa: cambio cada 7 puntos sumados (cada 5 en el decisivo)
    const cada = decisivo ? p.reglas.cambioDecisivoCada : p.reglas.cambioCada;
    if (suma > 0 && suma % cada === 0) cambiarDeCampo(p);
  } else if (decisivo && !p.yaHuboCambioDecisivo && suma === p.reglas.cambioDecisivoA) {
    // 4v4 y 6v6: un único cambio en el set decisivo, a los 8 puntos
    p.yaHuboCambioDecisivo = true;
    cambiarDeCampo(p);
  }
}

function deshacerCambioCampoSiProcede(p, sumaPrevia) {
  const decisivo = esSetDecisivo(p);

  if (p.modalidad === 'playa') {
    const cada = decisivo ? p.reglas.cambioDecisivoCada : p.reglas.cambioCada;
    if (sumaPrevia > 0 && sumaPrevia % cada === 0) cambiarDeCampo(p);
  } else if (decisivo && p.yaHuboCambioDecisivo && sumaPrevia === p.reglas.cambioDecisivoA) {
    p.yaHuboCambioDecisivo = false;
    cambiarDeCampo(p);
  }
}

function cambiarDeCampo(p) {
  p.ladosInvertidos = !p.ladosInvertidos;
  alAvisar('🔄 ¡Cambio de campo!');
}

// Devuelve true si el equipo podía pedir tiempo muerto (y se lo descuenta).
function usarTiempoMuerto(p, equipo) {
  if (p.terminado) return false;
  if (p.tmRestantes[equipo] === 0) return false;
  p.tmRestantes[equipo] -= 1;
  return true;
}

// ============================================================
// ESTADÍSTICAS
// ============================================================

// Puntos totales de cada equipo en todo el partido
function puntosTotales(p) {
  const total = [0, 0];
  for (const set of p.eventosPorSet) {
    for (const e of set) total[e] += 1;
  }
  for (const e of p.eventosSetActual) total[e] += 1;
  return total;
}

function duracionTexto(p) {
  const fin = p.finMs || Date.now();
  const min = Math.max(1, Math.round((fin - p.inicioMs) / 60000));
  if (min < 60) return min + ' min';
  return Math.floor(min / 60) + ' h ' + (min % 60) + ' min';
}

// Resumen en texto plano para compartir (WhatsApp, etc.)
function textoCompartir(p) {
  const g = p.sets[0] > p.sets[1] ? 0 : 1;
  const t = puntosTotales(p);
  return [
    '🏐 ' + p.nombres[0] + ' ' + p.sets[0] + ' - ' + p.sets[1] + ' ' + p.nombres[1],
    'Gana ' + p.nombres[g] + ' (' + p.modalidad + ')',
    'Sets: ' + p.setsCerrados.join(' · '),
    'Puntos totales: ' + t[0] + ' - ' + t[1],
    'Mayor racha: ' + p.nombres[0] + ' ' + p.rachaMax[0] + ', ' + p.nombres[1] + ' ' + p.rachaMax[1],
    'Duración: ' + duracionTexto(p),
  ].join('\n');
}
