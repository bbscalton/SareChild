package com.sarechild.shared

import org.junit.Assert.assertTrue
import org.junit.Test

class RiskClassifierTest {
    private val classifier = RiskClassifier()

    @Test
    fun leetspeakNormalization_detectsRisk() {
        val assessment = classifier.assess("s3nd nud3s pls")
        assertTrue(assessment.score > 0)
    }

    @Test
    fun groomingPattern_detectsSecrecy() {
        val assessment = classifier.assess("don't tell your parents about this")
        assertTrue(assessment.score >= 25)
    }

    @Test
    fun benignText_lowScore() {
        val assessment = classifier.assess("see you at soccer practice tomorrow")
        assertTrue(assessment.score == 0)
    }
}
