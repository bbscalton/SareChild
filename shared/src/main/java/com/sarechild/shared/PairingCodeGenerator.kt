package com.sarechild.shared

import java.security.SecureRandom

object PairingCodeGenerator {
    private val alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    private val random = SecureRandom()

    fun generate(length: Int = 6): String {
        val sb = StringBuilder(length)
        repeat(length) {
            sb.append(alphabet[random.nextInt(alphabet.length)])
        }
        return sb.toString()
    }
}
