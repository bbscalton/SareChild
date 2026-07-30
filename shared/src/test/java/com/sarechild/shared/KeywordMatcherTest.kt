package com.sarechild.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class KeywordMatcherTest {
    private val matcher = KeywordMatcher()

    @Test
    fun detectsDrugKeyword() {
        val hits = matcher.findHits("He said he can get weed tonight")
        assertTrue(hits.any { it.category == KeywordCategory.DRUGS })
    }

    @Test
    fun detectsGroomingPhrase() {
        val hits = matcher.findHits("Please don't tell your parents about this")
        assertTrue(hits.any { it.category == KeywordCategory.GROOMING })
    }

    @Test
    fun ignoresPartialWord() {
        val hits = matcher.findHits("The Essex team won")
        assertEquals(0, hits.count { it.phrase.equals("sex", ignoreCase = true) })
    }
}
