/**
 * Real-World Example: DevOps Incident Response System
 * Analyzes system alerts, diagnoses issues, and orchestrates response
 */

const AIToolkit = require('../src/index');

// Initialize with executor for DevOps actions
const ai = new AIToolkit({
  engines: {
    openai: process.env.OPENAI_API_KEY
  },
  withExecutor: true
});

// Register DevOps actions
ai.registerAction(
  'restart_service',
  async params => {
    console.log(`🔄 Restarting service: ${params.service}`);
    // In production: kubectl rollout restart deployment/${params.service}
    return {
      status: 'restarted',
      service: params.service,
      timestamp: new Date().toISOString()
    };
  },
  {
    description: 'Restart a Kubernetes service',
    parameters: { service: 'string', namespace: 'string' }
  }
);

ai.registerAction(
  'scale_horizontally',
  async params => {
    console.log(`📈 Scaling ${params.service} to ${params.replicas} replicas`);
    // In production: kubectl scale deployment/${params.service} --replicas=${params.replicas}
    return {
      status: 'scaled',
      service: params.service,
      replicas: params.replicas
    };
  },
  {
    description: 'Scale service horizontally',
    parameters: { service: 'string', replicas: 'number' }
  }
);

ai.registerAction(
  'rollback_deployment',
  async params => {
    console.log(`⏪ Rolling back ${params.service} to previous version`);
    // In production: kubectl rollout undo deployment/${params.service}
    return {
      status: 'rolled_back',
      service: params.service
    };
  },
  {
    description: 'Rollback to previous deployment',
    parameters: { service: 'string' }
  }
);

ai.registerAction(
  'increase_resources',
  async params => {
    console.log(
      `💪 Increasing resources for ${params.service}: CPU ${params.cpu}, Memory ${params.memory}`
    );
    // In production: kubectl set resources deployment/${params.service} --limits=cpu=${params.cpu},memory=${params.memory}
    return {
      status: 'resources_updated',
      service: params.service,
      cpu: params.cpu,
      memory: params.memory
    };
  },
  {
    description: 'Increase CPU/memory resources',
    parameters: { service: 'string', cpu: 'string', memory: 'string' }
  }
);

ai.registerAction(
  'enable_circuit_breaker',
  async params => {
    console.log(`🔌 Enabling circuit breaker for ${params.service}`);
    // In production: Update Istio/service mesh configuration
    return {
      status: 'circuit_breaker_enabled',
      service: params.service
    };
  },
  {
    description: 'Enable circuit breaker pattern',
    parameters: { service: 'string' }
  }
);

ai.registerAction(
  'drain_traffic',
  async params => {
    console.log(`🚦 Draining traffic from ${params.node || params.service}`);
    // In production: kubectl drain node/${params.node} or update load balancer
    return {
      status: 'traffic_drained',
      target: params.node || params.service
    };
  },
  {
    description: 'Drain traffic from node or service',
    parameters: { node: 'string', service: 'string' }
  }
);

ai.registerAction(
  'page_oncall',
  async params => {
    console.log(`📟 Paging on-call engineer: ${params.severity} severity`);
    console.log(`Message: ${params.message}`);
    // In production: PagerDuty/Opsgenie API call
    return {
      status: 'paged',
      severity: params.severity,
      incident_id: `INC-${Date.now()}`
    };
  },
  {
    description: 'Page on-call engineer',
    parameters: { severity: 'string', message: 'string' }
  }
);

ai.registerAction(
  'create_incident',
  async params => {
    console.log(`🚨 Creating incident: ${params.title}`);
    // In production: Create Jira/ServiceNow ticket
    return {
      status: 'incident_created',
      incident_id: `INC-${Date.now()}`,
      title: params.title
    };
  },
  {
    description: 'Create incident ticket',
    parameters: { title: 'string', description: 'string', severity: 'string' }
  }
);

/**
 * Analyze and respond to system incident
 */
async function handleIncident(alertData) {
  console.log('\n🚨 DevOps Incident Response System\n');
  console.log('Alert received:', `${alertData.substring(0, 150)}...\n`);

  // Step 1: Extract incident information
  console.log('1️⃣ Analyzing incident...');
  const incident = await ai.extract(alertData, {
    alert_type: {
      type: 'string',
      description: 'performance, error_rate, availability, security, capacity'
    },
    affected_services: {
      type: 'array',
      description: 'list of affected service names'
    },
    severity: {
      type: 'string',
      description: 'critical, high, medium, low'
    },
    metrics: {
      type: 'object',
      description: 'key metrics like error_rate, latency, cpu, memory, traffic'
    },
    error_messages: {
      type: 'array',
      description: 'specific error messages or stack traces'
    },
    affected_users: {
      type: 'string',
      description: 'estimation of affected users or percentage'
    },
    duration: {
      type: 'string',
      description: 'how long the issue has been occurring'
    },
    recent_changes: {
      type: 'array',
      description: 'recent deployments or configuration changes'
    },
    related_incidents: {
      type: 'array',
      description: 'similar past incidents or patterns'
    },
    environment: {
      type: 'string',
      description: 'production, staging, development'
    }
  });

  console.log('Incident Analysis:', JSON.stringify(incident.data, null, 2));

  // Step 2: Validate root cause
  console.log('\n2️⃣ Diagnosing root cause...');
  const diagnosis = await ai.validate(
    'What is the most likely root cause of this incident?',
    incident.data,
    {
      common_causes: [
        'High traffic/load causing resource exhaustion',
        'Memory leak in application',
        'Database connection pool exhausted',
        'Recent deployment introduced bug',
        'External dependency failure',
        'Network connectivity issues',
        'Configuration error',
        'Hardware/infrastructure failure',
        'DDoS or security attack',
        'Cache invalidation issues'
      ]
    }
  );

  console.log(`Root Cause Confidence: ${(diagnosis.score * 100).toFixed(1)}%`);
  console.log(`Diagnosis: ${diagnosis.reasoning}`);

  // Step 3: Generate incident summary
  console.log('\n3️⃣ Creating incident summary...');
  const summary = await ai.summarize(
    {
      incident: incident.data,
      diagnosis: diagnosis.reasoning,
      metrics: incident.data.metrics
    },
    {
      maxLength: 200,
      focus: 'business_impact_and_immediate_actions'
    }
  );

  console.log('Summary:', summary.summary);
  console.log('Key Points:', summary.keyPoints);

  // Step 4: Decide on response action
  console.log('\n4️⃣ Determining response action...');
  const response = await ai.decide(
    {
      severity: incident.data.severity,
      affected_services: incident.data.affected_services,
      metrics: incident.data.metrics,
      diagnosis: diagnosis.reasoning,
      environment: incident.data.environment,
      duration: incident.data.duration
    },
    ai.executor.getAvailableActions()
  );

  console.log(`\n⚡ Response Action: ${response.action.replace(/_/g, ' ').toUpperCase()}`);
  console.log(`Reasoning: ${response.reasoning}`);
  console.log(`Confidence: ${(response.confidence * 100).toFixed(1)}%`);

  // Step 5: Execute response
  console.log('\n5️⃣ Executing response...');
  const executionParams = generateExecutionParams(response.action, incident.data);
  const execution = await ai.execute({
    ...response,
    parameters: executionParams
  });

  console.log('Execution Result:', execution);

  // Generate runbook and postmortem template
  return {
    incident: {
      id: `INC-${Date.now()}`,
      severity: incident.data.severity,
      affected_services: incident.data.affected_services,
      environment: incident.data.environment
    },
    diagnosis: {
      root_cause: diagnosis.reasoning,
      confidence: diagnosis.score
    },
    response: {
      action_taken: response.action,
      parameters: executionParams,
      executed: execution.success,
      reasoning: response.reasoning
    },
    summary: summary.summary,
    runbook: generateRunbook(incident.data, diagnosis, response),
    monitoring: generateMonitoringChecklist(incident.data),
    postmortem_template: generatePostmortemTemplate(incident.data, diagnosis, response)
  };
}

/**
 * Generate execution parameters based on action and incident
 */
function generateExecutionParams(action, incidentData) {
  const service = incidentData.affected_services?.[0] || 'unknown-service';
  const metrics = incidentData.metrics || {};

  const params = {
    restart_service: {
      service,
      namespace: 'production'
    },
    scale_horizontally: {
      service,
      replicas: metrics.cpu > 80 ? 5 : 3
    },
    rollback_deployment: {
      service
    },
    increase_resources: {
      service,
      cpu: metrics.cpu > 80 ? '2000m' : '1000m',
      memory: metrics.memory > 80 ? '4Gi' : '2Gi'
    },
    enable_circuit_breaker: {
      service
    },
    drain_traffic: {
      service
    },
    page_oncall: {
      severity: incidentData.severity,
      message: `${incidentData.severity.toUpperCase()}: ${service} experiencing issues`
    },
    create_incident: {
      title: `${incidentData.severity}: ${service} - ${incidentData.alert_type}`,
      description: JSON.stringify(incidentData),
      severity: incidentData.severity
    }
  };

  return params[action] || params.create_incident;
}

/**
 * Generate runbook for the incident
 */
function generateRunbook(incident, diagnosis, response) {
  return `
## Incident Runbook

### Quick Actions
1. Check service health: \`kubectl get pods -l app=${incident.affected_services?.[0]}\`
2. View logs: \`kubectl logs -l app=${incident.affected_services?.[0]} --tail=100\`
3. Check metrics: Open Grafana dashboard for ${incident.affected_services?.[0]}

### Diagnosis Steps
1. ${diagnosis.reasoning}
2. Check recent deployments: \`kubectl rollout history deployment/${incident.affected_services?.[0]}\`
3. Verify external dependencies
4. Check database connections and performance

### Resolution Steps
- Primary action: ${response.action.replace(/_/g, ' ')}
- If not resolved, try rollback
- Consider scaling if load-related
- Enable circuit breaker if cascading failures

### Monitoring
- Watch error rate for next 30 minutes
- Monitor CPU and memory usage
- Check user impact metrics
`;
}

/**
 * Generate monitoring checklist
 */
function generateMonitoringChecklist(_incident) {
  return {
    immediate: [
      'Error rate returning to normal',
      'Response time < 200ms p95',
      'CPU usage < 70%',
      'Memory usage < 80%',
      'No new error logs'
    ],
    next_hour: [
      'No customer complaints',
      'All health checks passing',
      'No alert re-triggers',
      'Traffic patterns normal'
    ],
    next_day: [
      'Review metrics trends',
      'Check for any delayed impacts',
      'Verify backup systems',
      'Schedule postmortem'
    ]
  };
}

/**
 * Generate postmortem template
 */
function generatePostmortemTemplate(incident, diagnosis, response) {
  return `
# Postmortem: ${incident.affected_services?.[0]} Incident

## Incident Summary
- **Date**: ${new Date().toISOString()}
- **Duration**: ${incident.duration}
- **Severity**: ${incident.severity}
- **Affected Services**: ${incident.affected_services?.join(', ')}

## Impact
- **User Impact**: ${incident.affected_users}
- **Business Impact**: [TO BE FILLED]

## Root Cause
${diagnosis.reasoning}

## Timeline
- Alert triggered
- ${response.action} executed
- Service recovered

## Action Items
- [ ] Fix root cause
- [ ] Add monitoring for this scenario
- [ ] Update runbook
- [ ] Improve alerting

## Lessons Learned
- What went well
- What could be improved
`;
}

// Test scenarios
const incidents = [
  {
    name: 'High CPU Usage',
    alert: `
ALERT: Production CPU Critical
Time: 2024-03-15 14:23:00 UTC
Duration: 5 minutes

Service: api-gateway
Environment: production
Namespace: default

Metrics:
- CPU Usage: 95% (threshold: 80%)
- Memory: 72%
- Request Rate: 5000 req/s
- Error Rate: 0.5%
- P95 Latency: 850ms

Recent Changes:
- Deployed api-gateway v2.3.1 (30 minutes ago)
- No configuration changes

Error Logs:
- "Connection pool exhausted"
- "Timeout waiting for response from upstream"

Affected Users: ~10% experiencing slow responses
`
  },

  {
    name: 'Database Connection Issues',
    alert: `
ALERT: Database Connection Pool Exhausted
Time: 2024-03-15 09:15:00 UTC
Duration: 15 minutes

Service: user-service, order-service
Environment: production
Database: PostgreSQL primary

Metrics:
- Active Connections: 300/300 (maxed out)
- Query Queue Length: 450
- Slow Queries: 85
- CPU (DB Server): 45%
- Error Rate: 12%

Error Messages:
- "FATAL: remaining connection slots are reserved"
- "timeout: could not obtain connection from pool"
- "PSQLException: Connection refused"

Recent Changes:
- No recent deployments
- Database maintenance completed 2 hours ago

Affected Users: All users experiencing errors on checkout
Customer complaints: 15 in last 10 minutes
`
  },

  {
    name: 'Memory Leak After Deployment',
    alert: `
ALERT: Memory Usage Critical - Possible Memory Leak
Time: 2024-03-15 16:45:00 UTC
Duration: 45 minutes (gradually increasing)

Service: payment-processor
Environment: production
Pods: 4/4 affected

Metrics:
- Memory Usage: 92% and climbing
- Memory Growth Rate: +100MB/minute
- CPU: 60%
- GC Time: 40% of CPU
- Error Rate: Starting to increase (2% -> 5%)
- Request Latency: 200ms -> 1500ms

Recent Changes:
- Deployed payment-processor v3.1.0 (1 hour ago)
- New feature: Batch payment processing
- Updated dependencies including new Redis client

Error Logs:
- "OutOfMemoryError: Java heap space"
- "GC overhead limit exceeded"

Affected Users: Payment processing delays for all users
Business Impact: $10,000/minute in delayed transactions
`
  }
];

// Run examples
async function runExamples() {
  for (const incident of incidents) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚨 INCIDENT: ${incident.name}`);
    console.log('='.repeat(60));

    try {
      const result = await handleIncident(incident.alert);

      console.log('\n📋 INCIDENT RESPONSE REPORT');
      console.log('===========================');
      console.log(`Incident ID: ${result.incident.id}`);
      console.log(`Severity: ${result.incident.severity.toUpperCase()}`);
      console.log(`Root Cause: ${result.diagnosis.root_cause}`);
      console.log(`Action Taken: ${result.response.action_taken.replace(/_/g, ' ').toUpperCase()}`);

      console.log('\n📝 Runbook:');
      console.log(result.runbook);

      console.log('📊 Monitoring Checklist:');
      console.log('Immediate:', result.monitoring.immediate.slice(0, 3).join(', '));
    } catch (error) {
      console.error('Error handling incident:', error.message);
    }
  }
}

// Export
module.exports = { handleIncident };

// Run if called directly
if (require.main === module) {
  runExamples().catch(console.error);
}
