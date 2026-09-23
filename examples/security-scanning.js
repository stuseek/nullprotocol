/**
 * Security Scanning Example using @stuseek/ai-toolkit
 * Demonstrates how to use the 4 primitives for security analysis
 */

const AIToolkit = require('../src/index');

async function securityScan(targetUrl) {
  const ai = new AIToolkit({
    engines: {
      openai: process.env.OPENAI_API_KEY
    },
    defaultEngine: 'openai'
  });

  // Simulate HTTP response from target
  const httpResponse = {
    status: 200,
    headers: {
      server: 'Apache/2.4.41',
      'x-powered-by': 'PHP/7.2.24',
      'content-type': 'text/html'
    },
    body: `
      <html>
        <form action="/admin/login.php" method="post">
          <input type="text" name="username" />
          <input type="password" name="password" />
        </form>
        <!-- Debug: SQL Query: SELECT * FROM users WHERE id=1 -->
        <div class="error">Warning: mysql_connect() deprecated</div>
      </html>
    `
  };

  console.log('🔍 Scanning:', targetUrl);
  console.log('='.repeat(50));

  // Step 1: EXTRACT security indicators
  console.log('\n📊 EXTRACT - Identifying Security Indicators...');
  const indicators = await ai.extract(httpResponse, {
    serverInfo: {
      type: 'object',
      properties: {
        software: { type: 'string' },
        version: { type: 'string' },
        language: { type: 'string' }
      }
    },
    vulnerabilities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          severity: { type: 'string' },
          evidence: { type: 'string' }
        }
      }
    },
    exposedInfo: { type: 'array' },
    forms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          method: { type: 'string' },
          fields: { type: 'array' }
        }
      }
    }
  });

  console.log('Found indicators:', JSON.stringify(indicators.data, null, 2));

  // Step 2: VALIDATE security severity
  console.log('\n✅ VALIDATE - Assessing Security Risk...');
  const riskAssessment = await ai.validate(
    'Evaluate the security risk level based on OWASP standards. Consider exposed information, outdated software, and potential SQL injection vectors.',
    indicators.data,
    {
      criticalIndicators: ['SQL injection', 'Admin panel exposed', 'Outdated software'],
      owaspTop10: ['Injection', 'Broken Authentication', 'Sensitive Data Exposure']
    }
  );

  console.log('Risk Score:', riskAssessment.score);
  console.log(
    'Severity:',
    riskAssessment.score > 0.7 ? 'CRITICAL' : riskAssessment.score > 0.4 ? 'HIGH' : 'MEDIUM'
  );
  console.log('Strengths:', riskAssessment.strengths);
  console.log('Weaknesses:', riskAssessment.weaknesses);

  // Step 3: SUMMARIZE findings
  console.log('\n📝 SUMMARIZE - Generating Security Report...');
  const report = await ai.summarize(
    {
      target: targetUrl,
      indicators: indicators.data,
      assessment: riskAssessment
    },
    {
      maxLength: 300,
      focus: 'critical_vulnerabilities_and_remediation',
      format: 'bullet_points'
    }
  );

  console.log('Executive Summary:', report.summary);
  console.log('Key Security Issues:', report.keyPoints);
  console.log('Required Actions:', report.actionItems);

  // Step 4: DECIDE on response
  console.log('\n🧠 DECIDE - Determining Response Strategy...');
  const response = await ai.decide(
    {
      severity: riskAssessment.score,
      vulnerabilities: indicators.data.vulnerabilities,
      summary: report
    },
    [
      'immediate_patch_required',
      'schedule_maintenance_window',
      'monitor_and_assess',
      'acceptable_risk',
      'isolate_system',
      'penetration_test_recommended'
    ]
  );

  console.log('Recommended Action:', response.action);
  console.log('Reasoning:', response.reasoning);
  console.log('Confidence:', response.confidence);
  console.log('Alternative Actions:', response.alternatives);

  // Final Report
  console.log(`\n${'='.repeat(50)}`);
  console.log('🎯 SCAN COMPLETE');
  console.log('='.repeat(50));

  return {
    target: targetUrl,
    riskLevel:
      riskAssessment.score > 0.7 ? 'CRITICAL' : riskAssessment.score > 0.4 ? 'HIGH' : 'MEDIUM',
    vulnerabilities: indicators.data.vulnerabilities?.length || 0,
    recommendation: response.action,
    confidence: response.confidence
  };
}

// Example: Scan multiple targets
async function scanMultipleTargets() {
  const targets = [
    'https://example-vulnerable.com',
    'https://example-secure.com',
    'https://example-legacy.com'
  ];

  console.log('🚀 Starting Security Scan Campaign');
  console.log('Targets:', targets.length);
  console.log('');

  const results = [];
  for (const target of targets) {
    try {
      const result = await securityScan(target);
      results.push(result);
      console.log('');
    } catch (error) {
      console.error(`Failed to scan ${target}:`, error.message);
    }
  }

  // Summary
  console.log('\n📊 CAMPAIGN SUMMARY');
  console.log('='.repeat(50));
  results.forEach(r => {
    console.log(`${r.target}:`);
    console.log(`  Risk Level: ${r.riskLevel}`);
    console.log(`  Vulnerabilities: ${r.vulnerabilities}`);
    console.log(`  Action: ${r.recommendation}`);
  });

  const criticalCount = results.filter(r => r.riskLevel === 'CRITICAL').length;
  if (criticalCount > 0) {
    console.log(`\n⚠️  ALERT: ${criticalCount} critical risk targets identified!`);
  }
}

// Run the example
if (require.main === module) {
  scanMultipleTargets().catch(console.error);
}

module.exports = { securityScan };
