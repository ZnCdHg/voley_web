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
        conexion.commit()
        return jsonify(ok=True)
    finally:
        conexion.close()
