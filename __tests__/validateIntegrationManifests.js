const { readdirSync, existsSync, readFileSync } = require('fs');
const Handlebars = require('handlebars');
const Ajv = require('ajv');
const _ = require('lodash');

const { registerHelpers } = require('../helpers');
const jsonEscape = require('../utils/json-escape');
const schema = require('../manifest.schema.json');
const flagContext = require('../sample-context/flag/update-all-environments');
const projectContext = require('../sample-context/project/update');
const environmentContext = require('../sample-context/environment/update');

const OAUTH_INTEGRATIONS = ['appdynamics', 'servicenow']; // add oauth integrations here

registerHelpers();

const getDirectories = source =>
  readdirSync(source, { withFileTypes: true })
    .filter(dir => dir.isDirectory())
    .map(dir => dir.name);

const getFormVariableContext = formVariables => {
  const endpointContext = {};
  if (formVariables) {
    formVariables.forEach(formVariable => {
      switch (formVariable.type) {
        case 'string':
          endpointContext[formVariable.key] = formVariable.key;
          break;
        case 'boolean':
          endpointContext[formVariable.key] = true;
          break;
        case 'uri':
          endpointContext[formVariable.key] = `https://${formVariable.key}.com`;
          break;
        case 'enum':
          endpointContext[formVariable.key] = formVariable.key;
          break;
        case 'dynamicEnum':
          endpointContext[formVariable.key] = formVariable.key;
          break;
      }
    });
  }
  return endpointContext;
};

const getOAuthContext = requiresOAuth => {
  if (requiresOAuth) {
    const oauthContext = {
      baseURI: '$OAUTH_BASE_URI',
      accessToken: '$OAUTH_ACCESS_TOKEN',
    };
    return oauthContext;
  }
  return null;
};

const isJSONTemplate = templateFilename => {
  const lowercase = templateFilename.toLowerCase();
  return lowercase.endsWith('.json') || lowercase.endsWith('.json.hbs');
};

let manifests = [];
const ajv = new Ajv();
const validate = ajv.compile(schema);

const integrationDirs = getDirectories('integrations');
integrationDirs.forEach(dir => {
  const manifest = require(`../integrations/${dir}/manifest.json`);
  manifests.push([dir, manifest]);
});

const getTemplate = path => {
  const templateString = readFileSync(path, { encoding: 'utf-8' });
  const template = Handlebars.compile(templateString, {
    strict: true,
  });
  return template;
};

const getFullContext = (manifest, context, isJSON) => {
  const formVariables = _.get(manifest, 'formVariables', null);
  const requiresOAuth = _.get(manifest, 'requiresOAuth', null);
  const endpointContext = getFormVariableContext(formVariables);
  endpointContext.oauth = getOAuthContext(requiresOAuth);
  const fullContext = isJSON
    ? jsonEscape(Object.assign({}, context))
    : Object.assign({}, context);
  fullContext.formVariables = endpointContext;
  return fullContext;
};

describe('All integrations', () => {
  test.each(manifests)('Validate %s/manifest.json', (key, manifest) => {
    const res = validate(manifest);
    expect(validate.errors).toBe(null);
    expect(res).toBe(true);
  });

  test.each(manifests)('Icons exist for %s', (key, manifest) => {
    expect(existsSync(`./integrations/${key}/${manifest.icons.square}`)).toBe(
      true
    );
    expect(
      existsSync(`./integrations/${key}/${manifest.icons.horizontal}`)
    ).toBe(true);
  });

  test.each(manifests)('Overview ends in a period for %s', (key, manifest) => {
    expect(_.get(manifest, 'overview', '').endsWith('.')).toBe(true);
  });

  test.each(manifests)(
    'Referenced form variables exist for %s',
    (key, manifest) => {
      const formVariables = _.get(manifest, 'formVariables', null);
      const requiresOAuth = _.get(manifest, 'requiresOAuth', null);
      const endpoint = _.get(
        manifest,
        'capabilities.auditLogEventsHook.endpoint',
        null
      );
      if (endpoint) {
        const endpointContext = getFormVariableContext(formVariables);
        endpointContext.context = flagContext;
        endpointContext.oauth = getOAuthContext(requiresOAuth);
        const urlTemplate = Handlebars.compile(endpoint.url, {
          strict: true,
        });
        expect(
          () => urlTemplate(endpointContext),
          `${key}: request URL template must render successfully`
        ).not.toThrow();
        endpoint.headers.forEach(header => {
          const headerTemplate = Handlebars.compile(header.value, {
            strict: true,
          });
          expect(
            () => headerTemplate(endpointContext),
            `${key}: request header (${header.name}) value template must render successfully`
          ).not.toThrow();
        });
      }
    }
  );

  test.each(manifests)(
    'OAuth parameters are correctly set and accessible for %s',
    (key, manifest) => {
      const requiresOAuth = _.get(manifest, 'requiresOAuth', null);
      if (requiresOAuth) {
        expect(OAUTH_INTEGRATIONS).toEqual(expect.arrayContaining([key]));
        const oauthContext = getOAuthContext(requiresOAuth);
        expect(oauthContext).not.toBe(null);
      }
    }
  );

  test.each(manifests)(
    'defaultValue types match the type of the formVariable for %s',
    (key, manifest) => {
      const formVariables = _.get(manifest, 'formVariables', null);
      if (formVariables) {
        formVariables.forEach(formVariable => {
          if (!_.isUndefined(formVariable.defaultValue)) {
            expect(
              formVariable.isOptional,
              '"defaultValue" is only valid if "isOptional" is true. Use "placeholder" if you do not want the variable to be optional.'
            ).toBe(true);
            if (
              formVariable.type === 'string' ||
              formVariable.type === 'uri' ||
              formVariable.type === 'enum' ||
              formVariable.type === 'dynamicEnum'
            ) {
              expect(_.isString(formVariable.defaultValue)).toBe(true);
            } else if (formVariable.type === 'boolean') {
              expect(_.isBoolean(formVariable.defaultValue)).toBe(true);
            }
          }
        });
      }
    }
  );

  test.each(manifests)(
    'defaultValue is always provided when isOptional true for %s',
    (key, manifest) => {
      const formVariables = _.get(manifest, 'formVariables', null);
      if (formVariables) {
        formVariables.forEach(formVariable => {
          if (formVariable.isOptional) {
            expect(
              formVariable.defaultValue,
              '"isOptional" is only valid if "defaultValue" is provided.'
            ).toBeDefined();
          }
        });
      }
    }
  );

  test.each(manifests)(
    'no non-string formVariables have been set to isSecret for %s',
    (key, manifest) => {
      const formVariables = _.get(manifest, 'formVariables', null);
      if (formVariables) {
        formVariables.forEach(formVariable => {
          if (formVariable.type != 'string') {
            expect(formVariable.isSecret).not.toBe(true);
          }
        });
      }
    }
  );

  test.each(manifests)(
    'dynamicOptions is specified on dynamicEnum formVariable fields for %s',
    (key, manifest) => {
      const formVariables = _.get(manifest, 'formVariables', null);
      if (formVariables) {
        formVariables.forEach(formVariable => {
          if (formVariable.type == 'dynamicEnum') {
            expect(formVariable.dynamicOptions).toBeDefined();
          }
          if (formVariable.dynamicOptions) {
            expect(formVariable.type).toBe('dynamicEnum');
          }
        });
      }
    }
  );

  test.each(manifests)(
    'at least one externalCapability has been defined if no manifest capabilities for %s',
    (key, manifest) => {
      const capabilities = _.get(manifest, 'capabilities', null);
      if (!capabilities) {
        const otherCapabilities = _.get(manifest, 'otherCapabilities', null);
        expect(otherCapabilities).not.toBeNull();
        expect(otherCapabilities.length).toBeGreaterThan(0);
      }
    }
  );

  test.each(manifests)(
    'Templates can be successfully rendered for %s',
    (key, manifest) => {
      const flagTemplatePath = _.get(
        manifest,
        'capabilities.auditLogEventsHook.templates.flag',
        null
      );
      const projectTemplatePath = _.get(
        manifest,
        'capabilities.auditLogEventsHook.templates.project',
        null
      );
      const environmentTemplatePath = _.get(
        manifest,
        'capabilities.auditLogEventsHook.templates.environment',
        null
      );
      const defaultTemplatePath = _.get(
        manifest,
        'capabilities.auditLogEventsHook.templates.default',
        null
      );
      const validationTemplatePath = _.get(
        manifest,
        'capabilities.auditLogEventsHook.templates.validation',
        null
      );
      if (flagTemplatePath) {
        const path = `./integrations/${key}/${flagTemplatePath}`;
        expect(existsSync(path)).toBe(true);

        const template = getTemplate(path);
        const isJSON = isJSONTemplate(flagTemplatePath);
        const fullContext = getFullContext(manifest, flagContext, isJSON);
        expect(
          () => template(fullContext),
          `${key}: flag template must render successfully`
        ).not.toThrow();
        // Validate json templates render to valid json
        if (isJSON) {
          const rendered = template(fullContext);
          expect(
            () => JSON.parse(rendered),
            `${key} .json templates must render valid JSON\n${rendered}`
          ).not.toThrow();
        }
      }
      if (projectTemplatePath) {
        const path = `./integrations/${key}/${projectTemplatePath}`;
        expect(existsSync(path)).toBe(true);

        const template = getTemplate(path);
        const isJSON = isJSONTemplate(projectTemplatePath);
        const fullContext = getFullContext(manifest, projectContext, isJSON);
        expect(
          () => template(fullContext),
          `${key}: project template must render successfully`
        ).not.toThrow();
        // Validate json templates render to valid json
        if (isJSON) {
          const rendered = template(fullContext);
          expect(
            () => JSON.parse(rendered),
            `${key} project .json templates must render valid JSON\n${rendered}`
          ).not.toThrow();
        }
      }
      if (environmentTemplatePath) {
        const path = `./integrations/${key}/${environmentTemplatePath}`;
        expect(existsSync(path)).toBe(true);

        const template = getTemplate(path);
        const isJSON = isJSONTemplate(environmentTemplatePath);
        const fullContext = getFullContext(
          manifest,
          environmentContext,
          isJSON
        );
        expect(
          () => template(fullContext),
          `${key}: environment template must render successfully`
        ).not.toThrow();
        // Validate json templates render to valid json
        if (isJSON) {
          const rendered = template(fullContext);
          expect(
            () => JSON.parse(rendered),
            `${key} environment .json templates must render valid JSON\n${rendered}`
          ).not.toThrow();
        }
      }
      if (defaultTemplatePath) {
        const path = `./integrations/${key}/${defaultTemplatePath}`;
        expect(existsSync(path)).toBe(true);

        const template = getTemplate(path);
        const isJSON = isJSONTemplate(defaultTemplatePath);
        const fullContext = getFullContext(manifest, flagContext, isJSON);
        expect(
          () => template(fullContext),
          `${key}: default template must render successfully`
        ).not.toThrow();
        // Validate json templates render to valid json
        if (isJSON) {
          const rendered = template(fullContext);
          expect(
            () => JSON.parse(rendered),
            `${key} default .json templates must render valid JSON\n${rendered}`
          ).not.toThrow();
        }
      }
      if (validationTemplatePath) {
        const path = `./integrations/${key}/${validationTemplatePath}`;
        expect(existsSync(path)).toBe(true);
        const template = getTemplate(path);
        const isJSON = isJSONTemplate(validationTemplatePath);
        const fullContext = getFullContext(
          manifest,
          environmentContext,
          isJSON
        );
        expect(
          () => template(fullContext),
          `${key}: validation template must render successfully`
        ).not.toThrow();

        // Validation templates must not render an empty string
        const rendered = template(fullContext);
        expect(
          rendered.trim(),
          `${key} validation template must not render an empty string`
        ).not.toEqual('');

        // Validate json templates render to valid json
        if (isJSON) {
          expect(
            () => JSON.parse(rendered),
            `${key} validation .json templates must render valid JSON\n${rendered}`
          ).not.toThrow();
        }
      }
    }
  );
});
