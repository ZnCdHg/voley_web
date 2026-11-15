"""
API de la app Agenda Familiar (Flutter).

Va aparte del marcador: su propia base de datos (agenda.db) y sus rutas
bajo /agenda/api/. servidor.py solo la registra.

Una "familia" guarda toda su agenda como UN documento JSON. No hay
usuarios ni contraseñas: quien tiene el código de la familia (id + secreto)
entra. El código se pasa de un móvil a otro por WhatsApp.

El servidor NO mezcla nada. Guarda el documento con un número de versión:
  - GET  devuelve {version, datos}
  - PUT  manda {version, datos}; si alguien subió antes (la versión ya no
         coincide) responde 409 con lo último, y el móvil mezcla y reintenta.
La mezcla la hacen los móviles, entrada a entrada, por fecha de cambio.

Aparte, la app "Plataformas" de la tele sube sesiones (quién puso qué
plataforma, cuándo y hasta cuándo) a /familias/<id>/tele, con el mismo
código de familia. Agenda Familiar las lee para enseñar la estadística.
"""

import hashlib
import json
import os
import secrets
import sqlite3
import time

from flask import Blueprint, jsonify, request

CARPETA = os.path.dirname(os.path.abspath(__file__))
RUTA_BD = os.path.join(CARPETA, "agenda.db")

# Una agenda de familia ocupa unos pocos KB; esto es solo un tope contra abusos.
MAX_BYTES = 1_000_000

agenda = Blueprint("agenda", __name__, url_prefix="/agenda/api")


def bd():
    conexion = sqlite3.connect(RUTA_BD)
    conexion.row_factory = sqlite3.Row
    return conexion


def iniciar_bd():
    conexion = bd()
    conexion.execute("""
        CREATE TABLE IF NOT EXISTS familias (
            id             TEXT PRIMARY KEY,
            secreto_hash   TEXT NOT NULL,
            version        INTEGER NOT NULL,
            datos          TEXT NOT NULL,
            creada_en      INTEGER NOT NULL,
            actualizada_en INTEGER NOT NULL
        )
    """)
    # Sesiones de la tele: cada una tiene un id que pone la tele, así que si la
    # misma sesión llega dos veces (un reintento) no se duplica.
    conexion.execute("""
        CREATE TABLE IF NOT EXISTS tele_sesiones (
            familia_id TEXT NOT NULL,
            id         TEXT NOT NULL,
            persona    TEXT NOT NULL,
            paquete    TEXT NOT NULL,
            plataforma TEXT NOT NULL,
            inicio     INTEGER NOT NULL,
            fin        INTEGER NOT NULL,
            PRIMARY KEY (familia_id, id)
        )
    """)
    conexion.commit()
    conexion.close()


def ahora_ms():
    return int(time.time() * 1000)


def huella(secreto):
    # El secreto es aleatorio y largo (no una contraseña elegida por alguien),
    # así que basta un SHA-256: no hace falta un hash lento como el de las claves.
    return hashlib.sha256(secreto.encode()).hexdigest()


def cuerpo_json():
    """Devuelve (cuerpo, error). Rechaza envíos enormes o que no sean JSON."""
    if (request.content_length or 0) > MAX_BYTES:
        return None, (jsonify(error="La agenda es demasiado grande"), 413)
    cuerpo = request.get_json(silent=True)
    if not isinstance(cuerpo, dict):
        return None, (jsonify(error="Se esperaba un JSON"), 400)
    return cuerpo, None


def familia_autorizada(conexion, familia_id):
    """La fila de la familia si el secreto del header es el bueno; si no, None."""
    cabecera = request.headers.get("Authorization", "")
    secreto = cabecera[len("Bearer "):] if cabecera.startswith("Bearer ") else ""
    fila = conexion.execute("SELECT * FROM familias WHERE id = ?", (familia_id,)).fetchone()
    if fila is None or not secrets.compare_digest(fila["secreto_hash"], huella(secreto)):
        return None
    return fila


# Mismo mensaje exista o no la familia: así no se puede ir probando ids.
NO_ENCONTRADA = ({"error": "Código de familia incorrecto"}, 404)


@agenda.post("/familias")
def crear_familia():
    cuerpo, error = cuerpo_json()
    if error:
        return error
    datos = cuerpo.get("datos", {})
    if not isinstance(datos, dict):
        return jsonify(error="Los datos deben ser un objeto"), 400
    familia_id = secrets.token_hex(5)
    secreto = secrets.token_urlsafe(24)
    conexion = bd()
    conexion.execute(
        "INSERT INTO familias (id, secreto_hash, version, datos, creada_en, actualizada_en) "
        "VALUES (?, ?, 1, ?, ?, ?)",
        (familia_id, huella(secreto), json.dumps(datos), ahora_ms(), ahora_ms()),
    )
    conexion.commit()
    conexion.close()
    return jsonify(id=familia_id, secreto=secreto, version=1), 201


@agenda.get("/familias/<familia_id>")
def leer_familia(familia_id):
    conexion = bd()
    fila = familia_autorizada(conexion, familia_id)
    conexion.close()
    if fila is None:
        return NO_ENCONTRADA
    return jsonify(version=fila["version"], datos=json.loads(fila["datos"]),
                   actualizadaEn=fila["actualizada_en"])


@agenda.put("/familias/<familia_id>")
def guardar_familia(familia_id):
    cuerpo, error = cuerpo_json()
    if error:
        return error
    version = cuerpo.get("version")
    datos = cuerpo.get("datos")
    if not isinstance(version, int) or not isinstance(datos, dict):
        return jsonify(error="Faltan la versión o los datos"), 400

    conexion = bd()
    try:
        fila = familia_autorizada(conexion, familia_id)
        if fila is None:
            return NO_ENCONTRADA
        # El "AND version = ?" hace la comprobación y la escritura de una vez:
        # si otro móvil guardó entre medias, no se actualiza ninguna fila.
        actualizadas = conexion.execute(
            "UPDATE familias SET datos = ?, version = version + 1, actualizada_en = ? "
            "WHERE id = ? AND version = ?",
            (json.dumps(datos), ahora_ms(), familia_id, version),
        ).rowcount
        conexion.commit()
        if actualizadas == 0:
            actual = conexion.execute(
                "SELECT version, datos FROM familias WHERE id = ?", (familia_id,)
            ).fetchone()
            return jsonify(error="Alguien guardó antes", version=actual["version"],
                           datos=json.loads(actual["datos"])), 409
        return jsonify(version=version + 1)
    finally:
        conexion.close()


@agenda.delete("/familias/<familia_id>")
def borrar_familia(familia_id):
    conexion = bd()
    try:
        if familia_autorizada(conexion, familia_id) is None:
            return NO_ENCONTRADA
        conexion.execute("DELETE FROM familias WHERE id = ?", (familia_id,))
        conexion.execute("DELETE FROM tele_sesiones WHERE familia_id = ?", (familia_id,))
        conexion.commit()
        return jsonify(ok=True)
    finally:
        conexion.close()


# ---------------------------------------------------------------- tele

# Tope de sesiones por envío y de lectura: una familia no pone la tele miles de veces.
MAX_SESIONES_ENVIO = 500
MAX_SESIONES_LECTURA = 5000


def sesion_valida(s):
    textos = ("id", "persona", "paquete", "plataforma")
    if not isinstance(s, dict):
        return False
    if not all(isinstance(s.get(k), str) and 0 < len(s[k]) <= 100 for k in textos):
        return False
    inicio, fin = s.get("inicio"), s.get("fin")
    return (isinstance(inicio, int) and isinstance(fin, int)
            and not isinstance(inicio, bool) and not isinstance(fin, bool)
            and 0 < inicio <= fin)


@agenda.post("/familias/<familia_id>/tele")
def subir_sesiones_tele(familia_id):
    cuerpo, error = cuerpo_json()
    if error:
        return error
    sesiones = cuerpo.get("sesiones")
    if not isinstance(sesiones, list) or len(sesiones) > MAX_SESIONES_ENVIO:
        return jsonify(error="Se esperaba una lista de sesiones"), 400
    if not all(sesion_valida(s) for s in sesiones):
        return jsonify(error="Alguna sesión no es válida"), 400
    conexion = bd()
    try:
        if familia_autorizada(conexion, familia_id) is None:
            return NO_ENCONTRADA
        conexion.executemany(
            "INSERT OR IGNORE INTO tele_sesiones "
            "(familia_id, id, persona, paquete, plataforma, inicio, fin) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(familia_id, s["id"], s["persona"], s["paquete"], s["plataforma"], s["inicio"], s["fin"])
             for s in sesiones],
        )
        conexion.commit()
        return jsonify(ok=True, recibidas=len(sesiones))
    finally:
        conexion.close()


@agenda.get("/familias/<familia_id>/tele")
def leer_sesiones_tele(familia_id):
    try:
        desde = int(request.args.get("desde", "0"))
    except ValueError:
        return jsonify(error="'desde' debe ser un número"), 400
    conexion = bd()
    try:
        if familia_autorizada(conexion, familia_id) is None:
            return NO_ENCONTRADA
        filas = conexion.execute(
            "SELECT id, persona, paquete, plataforma, inicio, fin FROM tele_sesiones "
            "WHERE familia_id = ? AND fin >= ? ORDER BY inicio DESC LIMIT ?",
            (familia_id, desde, MAX_SESIONES_LECTURA),
        ).fetchall()
        return jsonify(sesiones=[dict(f) for f in filas])
    finally:
        conexion.close()
